/**
 * Workspace Durable Object — one per workspace, holds the investigation
 * state machine plus every WebSocket dashboard client.
 *
 * Responsibilities (this scaffold):
 *   - Persist incidents + events in DO SQLite.
 *   - Serialize incident execution with an in-memory queue + `running` guard.
 *   - Dedupe incoming signals to open incidents by signature (5 min window).
 *   - Drive the six-state machine (TRIAGE → GATHER → HYPOTHESIZE → PATCH →
 *     PR → MONITOR). Each state here is a placeholder that emits a trace
 *     pair, sleeps briefly, and advances. Real logic lands in a later
 *     pass.
 *   - Expose a WS event bus via hibernation API. `emit()` persists every
 *     `ServerMessage` to `events` and broadcasts to every active socket.
 *   - Run MONITOR via DO alarms (10 min prod / 30 s demo).
 */

import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import { getDemoConfig, type DemoModeConfig } from "../../../lib/env.ts";
import { createLogger } from "../../../lib/log.ts";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type HelloMsg,
  type IncidentResetMsg,
  type IncidentResolvedMsg,
  type IncidentStartedMsg,
  type IncidentState,
  type LogMsg,
  type PongMsg,
  type ServerMessage,
  type SignalMsg,
  type StateMsg,
} from "../../../lib/ws-events.ts";
import { wait, withTimeout } from "./lib/demo";
import {
  createClickHouseTools,
  type ClickHouseTools,
} from "./tools/clickhouse-tools";
import { createWorkspaceGit } from "./tools/git-tools";
import { traceTool } from "./tools/trace";
import type { Emit } from "./tools/trace";
import type { Env } from "./worker";

/** Shape posted by the tail worker to `/signal`. Mirrors apps/tail/src/index.ts. */
interface SignalPayload {
  readonly workspace: string;
  readonly events: SignalEvent[];
}

interface SignalEvent {
  readonly deployId: string;
  readonly errorClass: string;
  readonly level: string;
  readonly message: string;
  readonly route: string;
  readonly service: string;
  readonly signature: string;
  readonly signatureSource: string;
  readonly stackTrace: string;
  readonly statusCode: number;
  readonly timestamp: string;
  readonly traceId: string;
}

type IncidentRow = {
  readonly id: string;
  readonly signature: string;
  readonly state: IncidentState;
  readonly started_at: number;
  readonly resolved_at: number | null;
  readonly resolution: string | null;
  readonly service: string;
  readonly error_class: string;
  readonly message: string;
} & Record<string, SqlStorageValue>;

interface QueueItem {
  readonly signal: SignalEvent;
  readonly enqueuedAt: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS incidents (
     id TEXT PRIMARY KEY,
     signature TEXT NOT NULL,
     state TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     resolved_at INTEGER,
     resolution TEXT,
     service TEXT NOT NULL,
     error_class TEXT NOT NULL,
     message TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS incidents_by_signature
     ON incidents(signature, started_at DESC);`,
  `CREATE INDEX IF NOT EXISTS incidents_open
     ON incidents(state) WHERE resolved_at IS NULL;`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     incident_id TEXT,
     type TEXT NOT NULL,
     payload TEXT NOT NULL,
     ts INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS events_by_incident ON events(incident_id, id);`,
];

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEMO_STEP_MS = 200;
const PROD_STEP_MS = 1_000;

const TRANSITIONS: readonly IncidentState[] = [
  "TRIAGE",
  "GATHER",
  "HYPOTHESIZE",
  "PATCH",
  "PR",
  "MONITOR",
];

const log = createLogger("olly-agent", { component: "workspace-do" });

export class WorkspaceDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly workspace: Workspace;
  private readonly emitter: Emit;
  private readonly demo: DemoModeConfig;
  private state: IncidentState = "IDLE";
  private activeIncidentId: string | null = null;
  private readonly queue: QueueItem[] = [];
  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.workspace = new Workspace({ sql: this.sql, namespace: "workspace" });
    this.emitter = (msg) => this.emit(msg);
    this.demo = getDemoConfig({ DEMO_MODE: env.DEMO_MODE });

    for (const stmt of SCHEMA) {
      this.sql.exec(stmt);
    }

    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS gather_context (
         incident_id TEXT NOT NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         ts INTEGER NOT NULL,
         PRIMARY KEY (incident_id, key)
       )`,
    );

    this.restore();

    const initLog: LogMsg = {
      event: "workspace.demo_config",
      fields: {
        hypothesizeTurnCap: this.demo.hypothesizeTurnCap,
        hypothesizeWallMs: this.demo.hypothesizeWallMs,
        isDemo: this.demo.isDemo,
        modelTimeoutMs: this.demo.modelTimeoutMs,
        monitorWindowMs: this.demo.monitorWindowMs,
        sandboxTimeoutMs: this.demo.sandboxTimeoutMs,
      },
      level: "info",
      ts: new Date().toISOString(),
      type: "log",
    };
    this.emit(initLog);
  }

  // ---------- HTTP surface ----------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptSocket();
    }

    if (url.pathname === "/signal" && request.method === "POST") {
      const payload = (await request.json()) as SignalPayload;
      await this.ingestSignals(payload);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/internal/reset-incident" && request.method === "POST") {
      await this.reset();
      return Response.json({ ok: true, state: this.state });
    }

    if (url.pathname === "/internal/state") {
      return Response.json({
        incidentId: this.activeIncidentId,
        state: this.state,
      });
    }

    return new Response("workspace-do", { status: 200 });
  }

  // ---------- WebSocket (hibernation API) ----------

  private acceptSocket(): Response {
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const hello: HelloMsg = {
      protocol: PROTOCOL_VERSION,
      state: this.state,
      ts: new Date().toISOString(),
      type: "hello",
      ...(this.activeIncidentId
        ? { incidentId: this.activeIncidentId }
        : {}),
    };

    server.send(JSON.stringify(hello));

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ) {
    if (typeof message !== "string") {
      return;
    }

    const msg = parseClientMessage(message);

    if (!msg) {
      return;
    }

    if (msg.type === "ping") {
      const pong: PongMsg = { ts: new Date().toISOString(), type: "pong" };
      ws.send(JSON.stringify(pong));
      return;
    }

    // `subscribe` is advisory for now — the DO broadcasts to everyone.
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    log.debug("workspace.ws_closed", { code });
    // hibernation API manages the socket set; nothing to do here.
    void ws;
  }

  override async webSocketError(_ws: WebSocket, error: unknown) {
    log.warn("workspace.ws_error", { error: toError(error) });
  }

  // ---------- Event bus ----------

  private emit(msg: ServerMessage): void {
    const persisted = this.withTs(msg);
    const incidentId = getIncidentId(persisted);

    this.sql.exec(
      `INSERT INTO events (incident_id, type, payload, ts) VALUES (?, ?, ?, ?)`,
      incidentId,
      persisted.type,
      JSON.stringify(persisted),
      Date.parse(persisted.ts),
    );

    this.broadcast(persisted);
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);

    for (const ws of this.ctx.getWebSockets()) {
      ws.send(payload);
    }
  }

  private withTs(msg: ServerMessage): ServerMessage {
    if (msg.ts) {
      return msg;
    }
    return { ...msg, ts: new Date().toISOString() };
  }

  // ---------- Signal ingestion ----------

  private async ingestSignals(payload: SignalPayload): Promise<void> {
    if (!Array.isArray(payload?.events) || payload.events.length === 0) {
      return;
    }

    for (const signal of payload.events) {
      await this.ingestSignal(signal);
    }
  }

  private async ingestSignal(signal: SignalEvent): Promise<void> {
    const existing = this.findOpenIncidentForSignature(signal.signature);

    const signalMsg: SignalMsg = {
      errorClass: signal.errorClass,
      message: signal.message,
      route: signal.route,
      service: signal.service,
      signature: signal.signature,
      statusCode: signal.statusCode,
      ts: new Date().toISOString(),
      type: "signal",
      ...(existing ? { incidentId: existing.id } : {}),
    };

    this.emit(signalMsg);

    if (existing) {
      log.info("workspace.signal_deduped", {
        incidentId: existing.id,
        signature: signal.signature,
      });
      return;
    }

    this.queue.push({ enqueuedAt: Date.now(), signal });
    log.info("workspace.signal_enqueued", {
      queueDepth: this.queue.length,
      signature: signal.signature,
    });
    this.pump();
  }

  private findOpenIncidentForSignature(signature: string): IncidentRow | null {
    const cutoff = Date.now() - DEDUPE_WINDOW_MS;
    const rows = this.sql
      .exec<IncidentRow>(
        `SELECT * FROM incidents
         WHERE signature = ?
           AND started_at >= ?
           AND resolved_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
        signature,
        cutoff,
      )
      .toArray();

    return rows[0] ?? null;
  }

  // ---------- Execution pump ----------

  private pump(): void {
    if (this.running) {
      return;
    }

    const next = this.queue.shift();

    if (!next) {
      return;
    }

    this.running = true;
    this.ctx.waitUntil(
      this.runIncident(next.signal)
        .catch((err: unknown) => {
          log.error("workspace.incident_failed", {
            error: toError(err),
            incidentId: this.activeIncidentId,
          });
        })
        .finally(() => {
          this.running = false;
          this.pump();
        }),
    );
  }

  private async runIncident(signal: SignalEvent): Promise<void> {
    const id = crypto.randomUUID();
    const startedAt = Date.now();

    this.sql.exec(
      `INSERT INTO incidents
       (id, signature, state, started_at, resolved_at, resolution,
        service, error_class, message)
       VALUES (?, ?, 'TRIAGE', ?, NULL, NULL, ?, ?, ?)`,
      id,
      signal.signature,
      startedAt,
      signal.service,
      signal.errorClass,
      signal.message,
    );

    this.activeIncidentId = id;

    const started: IncidentStartedMsg = {
      errorClass: signal.errorClass,
      incidentId: id,
      message: signal.message,
      service: signal.service,
      signature: signal.signature,
      ts: new Date().toISOString(),
      type: "incident_started",
    };
    this.emit(started);

    for (const next of TRANSITIONS) {
      const cont = await this.transition(id, next, signal);

      if (!cont) {
        return;
      }
    }

    // MONITOR schedules the alarm; we leave the active incident in place.
    await this.scheduleMonitorAlarm(id, signal);
  }

  private async transition(
    incidentId: string,
    next: IncidentState,
    signal: SignalEvent,
  ): Promise<boolean> {
    this.state = next;

    this.sql.exec(
      `UPDATE incidents SET state = ? WHERE id = ?`,
      next,
      incidentId,
    );

    const stateMsg: StateMsg = {
      incidentId,
      state: next,
      ts: new Date().toISOString(),
      type: "state",
    };
    this.emit(stateMsg);

    log.info("workspace.state_enter", { incidentId, state: next });

    return this.runStateHandler(incidentId, next, signal);
  }

  // ---------- State handlers ----------

  private async runStateHandler(
    incidentId: string,
    state: IncidentState,
    signal: SignalEvent,
  ): Promise<boolean> {
    const stepMs = this.demo.isDemo ? DEMO_STEP_MS : PROD_STEP_MS;

    if (state === "TRIAGE") {
      await traceTool(
        this.emitter,
        incidentId,
        "clickhouse",
        "getErrorRate",
        { signature: signal.signature, windowSec: 300 },
        () => Promise.resolve({ stub: true, count: 0 }),
      );
      // TODO: call real clickhouse tool + LLM classifier to gate real vs noise.
      await wait(stepMs);
      return true;
    }

    if (state === "GATHER") {
      return this.runGather(incidentId, signal);
    }

    if (state === "HYPOTHESIZE") {
      await traceTool(
        this.emitter,
        incidentId,
        "state",
        "plan",
        {
          turnCap: this.demo.hypothesizeTurnCap,
          wallTimeSec: Math.round(this.demo.hypothesizeWallMs / 1000),
        },
        () => Promise.resolve({ stub: true }),
      );
      // TODO: drive codemode executor + Zen model. Cap at 8 turns / 60s.
      await wait(stepMs);
      return true;
    }

    if (state === "PATCH") {
      await traceTool(
        this.emitter,
        incidentId,
        "state",
        "applyEditPlan",
        { stub: true },
        () => Promise.resolve({ stub: true }),
      );
      // TODO: emit `diff` message once the patch is real.
      await wait(stepMs);
      return true;
    }

    if (state === "PR") {
      await traceTool(
        this.emitter,
        incidentId,
        "git",
        "push",
        {
          branch: `olly/${incidentId.slice(0, 8)}`,
        },
        () => Promise.resolve({ stub: true }),
      );
      // TODO: emit `pr_url` after real PR creation.
      await wait(stepMs);
      return true;
    }

    if (state === "MONITOR") {
      // MONITOR is driven by an alarm; the delay here is just for the
      // state trace. The real resolution happens in `alarm()`.
      await wait(stepMs);
      return true;
    }

    return true;
  }

  // ---------- GATHER ----------

  private async runGather(
    incidentId: string,
    signal: SignalEvent,
  ): Promise<boolean> {
    const tools = this.clickhouseTools();
    const service = signal.service;
    const owner = this.env.GITHUB_REPO_OWNER;
    const repo = this.env.GITHUB_REPO_NAME;
    const branch = this.env.GITHUB_REPO_DEFAULT_BRANCH;
    const skipClone = this.demo.isDemo && this.env.DEMO_SKIP_CLONE === "1";

    const whole = (async () => {
      const errors = await traceTool(
        this.emitter,
        incidentId,
        "clickhouse",
        "get_recent_errors",
        { service, limit: 50, windowSec: 15 * 60 },
        () => tools.getRecentErrors(service, 50, 15 * 60),
      );

      this.recordGather(incidentId, "recent_errors_count", String(errors.length));

      const deploys = await traceTool(
        this.emitter,
        incidentId,
        "clickhouse",
        "get_recent_deploys",
        { service, limit: 5 },
        () => tools.getRecentDeploys(service, 5),
      );

      this.recordGather(incidentId, "recent_deploys_count", String(deploys.length));

      if (skipClone) {
        const skipResult = { cloned: false, reason: "demo_skip" };
        await traceTool(
          this.emitter,
          incidentId,
          "git",
          "clone",
          { owner, repo, branch, depth: 1 },
          () => Promise.resolve(skipResult),
        );
        this.recordGather(incidentId, "clone_skipped", "demo_skip");
        return;
      }

      await traceTool(
        this.emitter,
        incidentId,
        "git",
        "clone",
        { owner, repo, branch, depth: 1 },
        () =>
          createWorkspaceGit(this.workspace, this.env.GITHUB_PAT).clone({
            url: `https://github.com/${owner}/${repo}.git`,
            branch,
            depth: 1,
            singleBranch: true,
          }),
      );
      this.recordGather(incidentId, "cloned", `${owner}/${repo}@${branch}`);
    })();

    return withTimeout(whole, this.demo.sandboxTimeoutMs, "gather")
      .then(() => true)
      .catch((err: unknown) => {
        this.escalate(incidentId, "gather_failed", err);
        return false;
      });
  }

  private recordGather(incidentId: string, key: string, value: string): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO gather_context (incident_id, key, value, ts)
       VALUES (?, ?, ?, ?)`,
      incidentId,
      key,
      value,
      Date.now(),
    );
  }

  private escalate(
    incidentId: string,
    event: string,
    err: unknown,
  ): void {
    const errObj = toError(err);

    log.error(`workspace.${event}`, { error: errObj, incidentId });

    const logMsg: LogMsg = {
      event: `workspace.${event}`,
      fields: { error: errObj.message, name: errObj.name },
      incidentId,
      level: "error",
      ts: new Date().toISOString(),
      type: "log",
    };
    this.emit(logMsg);

    this.sql.exec(
      `UPDATE incidents
       SET resolved_at = ?, resolution = 'escalated'
       WHERE id = ?`,
      Date.now(),
      incidentId,
    );

    const resolved: IncidentResolvedMsg = {
      incidentId,
      resolution: "escalated",
      ts: new Date().toISOString(),
      type: "incident_resolved",
    };
    this.emit(resolved);

    this.activeIncidentId = null;
    this.state = "IDLE";

    const stateMsg: StateMsg = {
      incidentId,
      state: "IDLE",
      ts: new Date().toISOString(),
      type: "state",
    };
    this.emit(stateMsg);
  }

  private clickhouseTools(): ClickHouseTools {
    return createClickHouseTools({
      database: this.env.CLICKHOUSE_DATABASE,
      password: this.env.CLICKHOUSE_PASSWORD,
      url: this.env.CLICKHOUSE_URL,
      user: this.env.CLICKHOUSE_USER,
    });
  }

  // ---------- MONITOR / alarm ----------

  private async scheduleMonitorAlarm(
    incidentId: string,
    signal: SignalEvent,
  ): Promise<void> {
    const windowMs = this.demo.monitorWindowMs;
    const wakeAt = Date.now() + windowMs;

    await this.ctx.storage.setAlarm(wakeAt);
    await this.ctx.storage.put("monitor", {
      incidentId,
      signature: signal.signature,
      service: signal.service,
      windowSec: Math.round(windowMs / 1000),
    });

    log.info("workspace.monitor_scheduled", {
      incidentId,
      wakeAt,
      windowMs,
    });
  }

  override async alarm(): Promise<void> {
    const pending = await this.ctx.storage.get<{
      incidentId: string;
      signature: string;
      service: string;
      windowSec: number;
    }>("monitor");

    if (!pending) {
      log.warn("workspace.alarm_without_pending", {});
      return;
    }

    await this.ctx.storage.delete("monitor");

    const tools = this.clickhouseTools();

    const result = await traceTool(
      this.emitter,
      pending.incidentId,
      "clickhouse",
      "getErrorRate",
      { signature: pending.signature, windowSec: pending.windowSec },
      () => tools.getErrorRate(pending.signature, pending.windowSec),
    ).catch((err: unknown) => {
      log.error("workspace.monitor_query_failed", {
        error: toError(err),
        incidentId: pending.incidentId,
      });
      return { count: -1, signature: pending.signature, windowSec: pending.windowSec };
    });

    const resolution: IncidentResolvedMsg["resolution"] =
      result.count <= 0 ? "fixed" : "escalated";

    this.sql.exec(
      `UPDATE incidents
       SET resolved_at = ?, resolution = ?
       WHERE id = ?`,
      Date.now(),
      resolution,
      pending.incidentId,
    );

    this.emit({
      incidentId: pending.incidentId,
      resolution,
      ts: new Date().toISOString(),
      type: "incident_resolved",
    });

    this.activeIncidentId = null;
    this.state = "IDLE";

    this.emit({
      incidentId: pending.incidentId,
      state: "IDLE",
      ts: new Date().toISOString(),
      type: "state",
    });

    log.info("workspace.monitor_resolved", {
      incidentId: pending.incidentId,
      resolution,
    });
  }

  // ---------- Reset ----------

  private async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("monitor");

    this.sql.exec(`DELETE FROM events`);
    this.sql.exec(`DELETE FROM incidents`);

    this.queue.length = 0;
    this.activeIncidentId = null;
    this.state = "IDLE";

    const msg: IncidentResetMsg = {
      state: "IDLE",
      ts: new Date().toISOString(),
      type: "incident_reset",
    };
    this.broadcast(msg);

    log.info("workspace.incident_reset", {});
  }

  // ---------- Boot ----------

  private restore(): void {
    const open = this.sql
      .exec<IncidentRow>(
        `SELECT * FROM incidents
         WHERE resolved_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .toArray();

    const first = open[0];

    if (!first) {
      return;
    }

    this.activeIncidentId = first.id;
    this.state = first.state;
  }

}

function parseClientMessage(raw: string): ClientMessage | null {
  const value = safeParse(raw);

  if (!value || typeof value !== "object") {
    return null;
  }

  const type = (value as { type?: unknown }).type;

  if (type === "ping") {
    return { type: "ping" };
  }

  if (type === "subscribe") {
    const incidentId = (value as { incidentId?: unknown }).incidentId;
    return typeof incidentId === "string"
      ? { incidentId, type: "subscribe" }
      : { type: "subscribe" };
  }

  return null;
}

function safeParse(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function getIncidentId(msg: ServerMessage): string | null {
  if ("incidentId" in msg && typeof msg.incidentId === "string") {
    return msg.incidentId;
  }
  return null;
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(String(reason));
}

// Re-export for worker.ts compile-time side-effects.
export type { Env };
