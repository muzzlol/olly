#!/usr/bin/env bun
import { createClient } from "@clickhouse/client-web";
import { createLogger } from "../lib/log.ts";

const log = createLogger("bootstrap-ch");

const url = process.env.CLICKHOUSE_HTTPS_URL;
const username = process.env.CLICKHOUSE_USER;
const password = process.env.CLICKHOUSE_PASSWORD;
const database = process.env.CLICKHOUSE_DATABASE ?? "default";

if (!url || !username || !password) {
  log.error("ch.missing_env", {
    hasUrl: Boolean(url),
    hasUser: Boolean(username),
    hasPassword: Boolean(password),
  });
  process.exit(1);
}

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
  query: "SELECT name, engine FROM system.tables WHERE database = {db:String} AND name = 'logs'",
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
