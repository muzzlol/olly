#!/usr/bin/env bun
import { createClient } from "@clickhouse/client-web";
import { createLogger } from "../lib/log.ts";

const log = createLogger("bootstrap-ch");

if (hasHelpFlag(Bun.argv.slice(2))) {
  writeUsage();
  process.exit(0);
}

const url = requireEnvOrExit("CLICKHOUSE_HTTPS_URL");
const username = requireEnvOrExit("CLICKHOUSE_USER");
const password = requireEnvOrExit("CLICKHOUSE_PASSWORD");
const database = process.env.CLICKHOUSE_DATABASE ?? "default";

const client = createClient({ url, username, password, database });

const ddl = `
CREATE TABLE IF NOT EXISTS logs (
  timestamp DateTime64(3),
  workspace String,
  service String,
  level LowCardinality(String),
  message String,
  stack_trace String,
  status_code UInt16,
  route String,
  deploy_id String,
  trace_id String,
  user_id String,
  attrs Map(String, String)
) ENGINE = MergeTree
ORDER BY (workspace, timestamp)
TTL toDateTime(timestamp) + INTERVAL 7 DAY
`;

log.info("ch.bootstrap_start", { database });

await client.command({ query: ddl });

const check = await client.query({
  query:
    "SELECT name, engine FROM system.tables WHERE database = {db:String} AND name = 'logs'",
  query_params: { db: database },
  format: "JSONEachRow",
});
const rows = (await check.json()) as Array<{ name: string; engine: string }>;

log.info("ch.bootstrap_done", {
  database,
  table: "logs",
  exists: rows.length > 0,
  engine: rows[0]?.engine,
});

await client.close();

function hasHelpFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

function requireEnvOrExit(name: string): string {
  const value = process.env[name];

  if (value && value.length > 0) {
    return value;
  }

  log.error("ch.missing_env", { name });
  process.stderr.write(
    `missing env: ${name}. Set it in .env per SPEC.md "Secrets".\n`,
  );
  process.exit(1);
}

function writeUsage(): void {
  process.stdout.write(
    [
      "Usage: bun --env-file=.env run scripts/bootstrap-ch.ts",
      "",
      "Creates the `logs` table on the configured ClickHouse service.",
      "Idempotent — safe to re-run.",
      "",
      "Required env:",
      "  CLICKHOUSE_HTTPS_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD",
      "Optional env:",
      "  CLICKHOUSE_DATABASE (default: default)",
      "",
      "Options:",
      "  -h, --help            Show this help text",
      "",
    ].join("\n"),
  );
}
