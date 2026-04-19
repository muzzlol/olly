#!/usr/bin/env bun
// Local dev smoke test: validates that the three workers and ClickHouse are
// reachable and that the agent's WS emits an initial `hello` frame.
// Prints one JSON line per check and a final `smoke.result` wide event.
// Exits 1 on any failure so CI / pre-demo scripts can gate on it.

import { createClient } from "@clickhouse/client-web";
import { createLogger } from "../lib/log.ts";

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: Record<string, unknown>;
}

const log = createLogger("smoke");

if (hasHelpFlag(Bun.argv.slice(2))) {
  writeUsage();
  process.exit(0);
}

const agentUrl = process.env.AGENT_URL_LOCAL ?? "http://localhost:1337";
const tailUrl = process.env.TAIL_URL_LOCAL ?? "http://localhost:1338";
const dashboardUrl = process.env.DASHBOARD_URL_LOCAL ?? "http://localhost:5173";
const wsUrl = agentUrl.replace(/^http/u, "ws") + "/ws";

const results: CheckResult[] = [];

results.push(
  await checkHttp("agent.http", agentUrl, (status) => status === 200),
);
// Tail worker has no fetch handler. workerd returns 500 locally and 1101 in
// deployed Cloudflare runs. Either means the worker is reachable — treat as pass.
results.push(
  await checkHttp(
    "tail.http",
    tailUrl,
    (status) => status === 200 || status === 500 || status === 1101,
  ),
);
results.push(
  await checkHttp("dashboard.http", dashboardUrl, (status) => status === 200),
);
results.push(await checkClickhouse());
results.push(await checkAgentWs(wsUrl));

for (const r of results) {
  process.stdout.write(`${JSON.stringify(r)}\n`);
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;

log.info("smoke.result", {
  total: results.length,
  passed,
  failed,
  checks: results.map((r) => ({ name: r.name, ok: r.ok })),
});

process.exit(failed === 0 ? 0 : 1);

async function checkHttp(
  name: string,
  url: string,
  accept: (status: number) => boolean,
): Promise<CheckResult> {
  const started = Date.now();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(3000),
  }).catch((err: unknown) => err);

  if (response instanceof Error) {
    return {
      name,
      ok: false,
      detail: {
        url,
        error: response.message,
        ms: Date.now() - started,
      },
    };
  }

  const res = response as Response;
  // Drain so bun frees the connection before the WS check opens another socket.
  await res.arrayBuffer().catch(() => new ArrayBuffer(0));

  return {
    name,
    ok: accept(res.status),
    detail: { url, status: res.status, ms: Date.now() - started },
  };
}

async function checkClickhouse(): Promise<CheckResult> {
  const started = Date.now();
  const url = process.env.CLICKHOUSE_HTTPS_URL;
  const username = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;
  const database = process.env.CLICKHOUSE_DATABASE ?? "default";

  if (!url || !username || !password) {
    return {
      name: "clickhouse.select_1",
      ok: false,
      detail: { error: "missing_env" },
    };
  }

  const client = createClient({ url, username, password, database });
  const result = await client
    .query({ query: "SELECT 1 AS one", format: "JSONEachRow" })
    .catch((err: unknown) => err);

  if (result instanceof Error) {
    await client.close().catch(() => {});
    return {
      name: "clickhouse.select_1",
      ok: false,
      detail: { error: result.message, ms: Date.now() - started },
    };
  }

  const rows = (await (result as { json: () => Promise<unknown> }).json()) as Array<{
    one: number;
  }>;
  await client.close();

  return {
    name: "clickhouse.select_1",
    ok: rows[0]?.one === 1,
    detail: { rows: rows.length, ms: Date.now() - started },
  };
}

function checkAgentWs(url: string): Promise<CheckResult> {
  const started = Date.now();

  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      resolve({
        name: "agent.ws_hello",
        ok: false,
        detail: { url, error: "timeout_3s", ms: Date.now() - started },
      });
    }, 3000);

    ws.addEventListener("open", () => {
      // nothing to do; the agent DO pushes the first frame on accept.
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      clearTimeout(timer);
      const frame = parseFrame(event.data);
      ws.close();
      resolve({
        name: "agent.ws_hello",
        ok: frame?.type === "hello",
        detail: {
          url,
          firstFrame: frame,
          ms: Date.now() - started,
        },
      });
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({
        name: "agent.ws_hello",
        ok: false,
        detail: { url, error: "ws_error", ms: Date.now() - started },
      });
    });
  });
}

function parseFrame(data: unknown): { type?: string } | null {
  if (typeof data !== "string") {
    return null;
  }

  // Minimal-risk parse: the agent DO always sends JSON objects on this socket.
  // If anything else shows up we surface it as an unknown frame.
  const first = data.trimStart()[0];

  if (first !== "{" && first !== "[") {
    return { type: "(non-json)" };
  }

  const parsed = JSON.parse(data) as unknown;

  if (parsed && typeof parsed === "object") {
    return parsed as { type?: string };
  }

  return null;
}

function hasHelpFlag(argv: string[]): boolean {
  return argv.some((a) => a === "--help" || a === "-h");
}

function writeUsage(): void {
  process.stdout.write(
    [
      "Usage: bun --env-file=.env run scripts/smoke.ts",
      "",
      "Sanity-checks the local `bun run dev` loop:",
      "  - agent     http://localhost:1337/     (expect 200)",
      "  - tail      http://localhost:1338/     (expect 1101, no fetch handler)",
      "  - dashboard http://localhost:5173/     (expect 200)",
      "  - clickhouse SELECT 1",
      "  - agent ws://localhost:1337/ws first frame type == 'hello' (3s timeout)",
      "",
      "Prints one JSON result per check, a final smoke.result wide event,",
      "and exits 1 on any failure.",
      "",
      "Options:",
      "  -h, --help    Show this help text",
      "",
      "Optional env overrides:",
      "  AGENT_URL_LOCAL, TAIL_URL_LOCAL, DASHBOARD_URL_LOCAL",
      "",
    ].join("\n"),
  );
}
