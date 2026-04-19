#!/usr/bin/env bun
import { createClient } from "@clickhouse/client-web";
import { createLogger } from "../lib/log.ts";

interface Options {
  readonly format: string;
  readonly limit: number;
  readonly query: string;
  readonly help: boolean;
}

const log = createLogger("query-ch");
const opts = parseArgs(Bun.argv.slice(2));

if (opts.help) {
  writeUsage();
  process.exit(0);
}

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

const query = opts.query || defaultQuery(opts.limit);

if (!isReadOnlyQuery(query)) {
  log.error("ch.query_rejected", {
    reason: "query_must_be_single_statement_read_only",
    query,
  });
  process.exit(1);
}

const sql = applyFormat(query, opts.format);
const client = createClient({ url, username, password, database });
const result = await client.query({ query: sql });
const text = await result.text();

process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

await client.close();

function parseArgs(argv: string[]): Options {
  let format = "JSONEachRow";
  let limit = 20;
  const query: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      return { format, limit, query: "", help: true };
    }

    if (arg === "--format" || arg === "-f") {
      const value = argv[i + 1];

      if (!value) {
        failUsage("missing value for --format");
      }

      format = parseFormat(value);
      i += 1;
      continue;
    }

    if (arg === "--limit" || arg === "-n") {
      const value = argv[i + 1];

      if (!value) {
        failUsage("missing value for --limit");
      }

      limit = parseLimit(value);
      i += 1;
      continue;
    }

    query.push(arg);
  }

  return {
    format,
    limit,
    query: query.join(" ").trim(),
    help: false,
  };
}

function parseFormat(value: string): string {
  if (/^[A-Za-z0-9_]+$/.test(value)) {
    return value;
  }

  failUsage(`invalid format: ${value}`);
}

function parseLimit(value: string): number {
  const limit = Number(value);

  if (Number.isInteger(limit) && limit > 0) {
    return limit;
  }

  failUsage(`invalid limit: ${value}`);
}

function defaultQuery(limit: number): string {
  return [
    "SELECT",
    "  timestamp,",
    "  workspace,",
    "  service,",
    "  level,",
    "  message,",
    "  status_code,",
    "  route,",
    "  deploy_id,",
    "  trace_id",
    "FROM logs",
    "ORDER BY timestamp DESC",
    `LIMIT ${limit}`,
  ].join("\n");
}

function isReadOnlyQuery(query: string): boolean {
  const body = stripQuery(query);

  if (!body) {
    return false;
  }

  if (body.includes(";")) {
    return false;
  }

  const head = body.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();

  return (
    head === "SELECT" ||
    head === "SHOW" ||
    head === "DESCRIBE" ||
    head === "DESC" ||
    head === "EXPLAIN" ||
    head === "WITH"
  );
}

function stripQuery(query: string): string {
  const body = query
    .trim()
    .replace(/^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/\s*))+/u, "")
    .trim();

  if (body.endsWith(";")) {
    return body.slice(0, -1).trimEnd();
  }

  return body;
}

function applyFormat(query: string, format: string): string {
  if (/\bFORMAT\s+[A-Za-z0-9_]+\s*;?\s*$/iu.test(query)) {
    return query;
  }

  const body = query.trimEnd();

  if (body.endsWith(";")) {
    return `${body.slice(0, -1)}\nFORMAT ${format};`;
  }

  return `${body}\nFORMAT ${format}`;
}

function writeUsage(): void {
  process.stdout.write(
    [
      "Usage: bun --env-file=.env run scripts/query-ch.ts [options] [sql]",
      "",
      "Runs a single read-only ClickHouse query against the shared logs DB.",
      "Defaults to recent rows from `logs` when no SQL is passed.",
      "",
      "Options:",
      "  -f, --format <name>  Response format to append when SQL has no FORMAT clause (default: JSONEachRow)",
      "  -n, --limit <rows>   Row limit for the default query (default: 20)",
      "  -h, --help           Show this help text",
      "",
      "Examples:",
      '  bun --env-file=.env run scripts/query-ch.ts',
      '  bun --env-file=.env run scripts/query-ch.ts "SELECT count() AS rows FROM logs"',
      '  bun --env-file=.env run scripts/query-ch.ts -f JSON "SELECT level, count() AS n FROM logs GROUP BY level ORDER BY n DESC"',
      "",
    ].join("\n"),
  );
}

function failUsage(message: string): never {
  log.error("ch.invalid_args", { message });
  writeUsage();
  process.exit(1);
}
