/**
 * TRIAGE — first state after a signal lands.
 *
 * Three decisions in order:
 *   1. Dedupe against recent open incidents (5 min window). If we have a
 *      match, append to that incident (join as a signal) and do NOT kick
 *      off a new investigation.
 *   2. Rate check via ClickHouse (`getErrorRate`). Count is informational
 *      only — we record it and always continue because the tail-worker
 *      already confirmed at least one error occurred.
 *   3. Scope check: walk the stack trace for a "user-code-shaped" frame.
 *      If none, emit `incident_out_of_scope` and bounce to IDLE.
 *
 * Emits `LogMsg` wide events at each boundary so the dashboard can render
 * the decision trail.
 */

import type { ClickHouseTools } from "../tools/clickhouse-tools";
import { traceTool, type Emit } from "../tools/trace";
import type {
  IncidentOutOfScopeMsg,
  LogMsg,
  SignalMsg,
} from "../../../../lib/ws-events.ts";

export type TriageVerdict =
  | { kind: "deduped"; existingIncidentId: string }
  | { kind: "out_of_scope"; reason: string }
  | {
      kind: "continue";
      errorRateCount: number;
      stackFrame: string;
      stackFile: string;
    };

export interface TriageInput {
  readonly incidentId: string;
  readonly signal: TriageSignal;
  readonly emit: Emit;
  readonly clickhouse: ClickHouseTools;
  readonly findOpenIncidentForSignature: (
    signature: string,
    excludeId: string,
  ) => { id: string } | null;
  readonly recordGather: (incidentId: string, key: string, value: string) => void;
}

export interface TriageSignal {
  readonly signature: string;
  readonly service: string;
  readonly errorClass: string;
  readonly message: string;
  readonly route: string;
  readonly statusCode: number;
  readonly stackTrace: string;
}

const OUT_OF_SCOPE_PATTERNS = [
  "node_modules",
  "workerd-internal",
  "cloudflare:",
  "worker://",
  "internal/",
  "node:internal",
  "[native code]",
];

export async function triage(input: TriageInput): Promise<TriageVerdict> {
  const { incidentId, signal, emit, clickhouse, recordGather } = input;

  // 1. Dedupe — exclude self (the current incident row was already inserted).
  const existing = input.findOpenIncidentForSignature(
    signal.signature,
    incidentId,
  );

  if (existing) {
    emit(
      logMsg(incidentId, "triage.dedupe_hit", "info", {
        existingIncidentId: existing.id,
        signature: signal.signature,
      }),
    );

    const joined: SignalMsg = {
      errorClass: signal.errorClass,
      incidentId: existing.id,
      message: signal.message,
      route: signal.route,
      service: signal.service,
      signature: signal.signature,
      statusCode: signal.statusCode,
      ts: new Date().toISOString(),
      type: "signal",
    };
    emit(joined);

    return { kind: "deduped", existingIncidentId: existing.id };
  }

  emit(
    logMsg(incidentId, "triage.dedupe_checked", "info", {
      signature: signal.signature,
      hit: false,
    }),
  );

  // 2. Rate check — informational only.
  const rate = await traceTool(
    emit,
    incidentId,
    "clickhouse",
    "getErrorRate",
    { signature: signal.signature, windowSec: 300 },
    () => clickhouse.getErrorRate(signal.signature, 300),
  ).catch((err: unknown) => {
    emit(
      logMsg(incidentId, "triage.rate_check_failed", "warn", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { count: 0, signature: signal.signature, windowSec: 300 };
  });

  recordGather(incidentId, "error_rate_5min", String(rate.count));

  emit(
    logMsg(incidentId, "triage.rate_checked", "info", {
      count: rate.count,
      signature: signal.signature,
      windowSec: 300,
    }),
  );

  // 3. Scope check.
  const scope = findMappableFrame(signal.stackTrace);

  emit(
    logMsg(incidentId, "triage.scope_checked", "info", {
      mappable: scope !== null,
      frame: scope?.frame ?? "",
      file: scope?.file ?? "",
    }),
  );

  if (!scope) {
    const reason = "no mappable stack frame";
    const outOfScope: IncidentOutOfScopeMsg = {
      incidentId,
      reason,
      ts: new Date().toISOString(),
      type: "incident_out_of_scope",
    };
    emit(outOfScope);
    return { kind: "out_of_scope", reason };
  }

  recordGather(incidentId, "stack_frame", scope.frame);
  recordGather(incidentId, "stack_file", scope.file);

  return {
    kind: "continue",
    errorRateCount: rate.count,
    stackFrame: scope.frame,
    stackFile: scope.file,
  };
}

/**
 * Walk a stack trace looking for a frame that points to something
 * user-code-shaped: a relative-looking path that is NOT an internal
 * runtime frame. Returns the frame string and the extracted file path
 * (relative to repo root when possible).
 */
export function findMappableFrame(
  stackTrace: string,
): { frame: string; file: string } | null {
  for (const raw of stackTrace.split("\n")) {
    const line = raw.trim();

    if (line === "" || !line.startsWith("at ")) {
      continue;
    }

    if (isOutOfScope(line)) {
      continue;
    }

    const file = extractFilePath(line);

    if (file === "") {
      continue;
    }

    if (isOutOfScopePath(file)) {
      continue;
    }

    return { frame: line.slice(3).trim(), file };
  }

  return null;
}

function isOutOfScope(line: string): boolean {
  const lower = line.toLowerCase();

  for (const needle of OUT_OF_SCOPE_PATTERNS) {
    if (lower.includes(needle)) {
      return true;
    }
  }

  return false;
}

function isOutOfScopePath(file: string): boolean {
  const lower = file.toLowerCase();

  if (lower.startsWith("cloudflare:") || lower.startsWith("worker:")) {
    return true;
  }

  if (lower.startsWith("node:")) {
    return true;
  }

  if (lower.includes("node_modules/")) {
    return true;
  }

  return false;
}

function extractFilePath(line: string): string {
  // Typical formats:
  //   at fn (src/foo/bar.ts:10:5)
  //   at fn (file:///.../src/foo/bar.ts:10:5)
  //   at src/foo/bar.ts:10:5
  const parenStart = line.lastIndexOf("(");
  const parenEnd = line.lastIndexOf(")");

  const body =
    parenStart >= 0 && parenEnd > parenStart
      ? line.slice(parenStart + 1, parenEnd)
      : line.slice(3).trim();

  const withoutLineCol = body.replace(/:\d+(?::\d+)?$/u, "");

  if (withoutLineCol === "") {
    return "";
  }

  // Prefer a `src/...` subpath when present — that's what the scope
  // invariant cares about — but accept any relative-looking path.
  const srcIdx = withoutLineCol.lastIndexOf("src/");

  if (srcIdx >= 0) {
    return withoutLineCol.slice(srcIdx);
  }

  // Strip file:// prefixes.
  if (withoutLineCol.startsWith("file://")) {
    return withoutLineCol.slice("file://".length);
  }

  return withoutLineCol;
}

function logMsg(
  incidentId: string,
  event: string,
  level: LogMsg["level"],
  fields: Record<string, unknown>,
): LogMsg {
  return {
    event,
    fields,
    incidentId,
    level,
    ts: new Date().toISOString(),
    type: "log",
  };
}
