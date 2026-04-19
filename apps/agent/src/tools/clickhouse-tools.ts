/**
 * ClickHouse tools — pure functions over the shared `logs` table.
 *
 * Named queries (`getErrorRate`, `getRecentDeploys`, etc.) exist for
 * dashboard legibility; `runSql` is a read-only escape hatch for the
 * agent to write arbitrary SELECTs. All queries are strictly read-only:
 * any write keyword causes `runSql` to reject.
 *
 * These are the RAW functions. The codemode call site wraps them with
 * `tool({ inputSchema, execute })` from `ai`; the state machine wraps
 * them with `traceTool` so the dashboard sees each invocation.
 */

import { createClient } from "@clickhouse/client-web";
import type { ClickHouseClient } from "@clickhouse/client-web";

export interface ClickHouseConfig {
  readonly url: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly workspace?: string;
}

export interface ErrorRateResult {
  readonly signature: string;
  readonly windowSec: number;
  readonly count: number;
}

export interface DeployRow {
  readonly deployId: string;
  readonly service: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly events: number;
}

export interface LogRowLite {
  readonly timestamp: string;
  readonly service: string;
  readonly level: string;
  readonly message: string;
  readonly route: string;
  readonly statusCode: number;
  readonly traceId: string;
  readonly userId: string;
  readonly stackTrace: string;
  readonly deployId: string;
}

export interface ErrorContext {
  readonly traceId: string;
  readonly rows: readonly LogRowLite[];
}

const WRITE_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "alter",
  "drop",
  "truncate",
  "rename",
  "attach",
  "detach",
  "create",
  "replace",
  "grant",
  "revoke",
  "optimize",
];

const DEFAULT_WORKSPACE = "default";
const MAX_ROWS = 500;

export function createClickHouseTools(config: ClickHouseConfig) {
  const workspace = config.workspace ?? DEFAULT_WORKSPACE;

  return {
    getErrorRate: (signature: string, windowSec: number) =>
      getErrorRate(config, workspace, signature, windowSec),
    getRecentDeploys: (service: string, limit = 10) =>
      getRecentDeploys(config, workspace, service, limit),
    getErrorsForUser: (userId: string, limit = 50) =>
      getErrorsForUser(config, workspace, userId, limit),
    getRecentErrors: (service: string, limit = 50, windowSec = 900) =>
      getRecentErrors(config, workspace, service, limit, windowSec),
    getErrorContext: (traceId: string) =>
      getErrorContext(config, workspace, traceId),
    runSql: (query: string) => runSql(config, query),
  };
}

export type ClickHouseTools = ReturnType<typeof createClickHouseTools>;

async function getErrorRate(
  config: ClickHouseConfig,
  workspace: string,
  signature: string,
  windowSec: number,
): Promise<ErrorRateResult> {
  const client = toClient(config);
  const result = await client
    .query({
      format: "JSONEachRow",
      query: `
        SELECT count() AS c
        FROM logs
        WHERE workspace = {workspace:String}
          AND timestamp >= now64(3) - INTERVAL {window:UInt32} SECOND
          AND (level IN ('error', 'fatal') OR status_code >= 500)
          AND lower(message) LIKE concat('%', lower({sig:String}), '%')
      `,
      query_params: {
        sig: shortenSignature(signature),
        window: windowSec,
        workspace,
      },
    })
    .then((r) => r.json<{ c: string | number }>());

  const first = result[0];
  const count = first ? Number(first.c) : 0;

  await client.close();

  return { count, signature, windowSec };
}

async function getRecentDeploys(
  config: ClickHouseConfig,
  workspace: string,
  service: string,
  limit: number,
): Promise<DeployRow[]> {
  const client = toClient(config);
  const rows = await client
    .query({
      format: "JSONEachRow",
      query: `
        SELECT
          deploy_id AS deployId,
          service,
          min(timestamp) AS firstSeen,
          max(timestamp) AS lastSeen,
          count() AS events
        FROM logs
        WHERE workspace = {workspace:String}
          AND service = {service:String}
          AND deploy_id != ''
        GROUP BY deploy_id, service
        ORDER BY lastSeen DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { limit: clampLimit(limit), service, workspace },
    })
    .then((r) => r.json<DeployRow & { events: string | number }>());

  await client.close();

  return rows.map((row) => ({ ...row, events: Number(row.events) }));
}

async function getErrorsForUser(
  config: ClickHouseConfig,
  workspace: string,
  userId: string,
  limit: number,
): Promise<LogRowLite[]> {
  return selectLogRows(
    config,
    `
      SELECT ${LOG_ROW_SELECT}
      FROM logs
      WHERE workspace = {workspace:String}
        AND user_id = {userId:String}
        AND (level IN ('error', 'fatal') OR status_code >= 500)
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32}
    `,
    { limit: clampLimit(limit), userId, workspace },
  );
}

async function getRecentErrors(
  config: ClickHouseConfig,
  workspace: string,
  service: string,
  limit: number,
  windowSec: number,
): Promise<LogRowLite[]> {
  return selectLogRows(
    config,
    `
      SELECT ${LOG_ROW_SELECT}
      FROM logs
      WHERE workspace = {workspace:String}
        AND service = {service:String}
        AND timestamp >= now64(3) - INTERVAL {window:UInt32} SECOND
        AND (level IN ('error', 'fatal') OR status_code >= 500)
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32}
    `,
    {
      limit: clampLimit(limit),
      service,
      window: windowSec,
      workspace,
    },
  );
}

async function getErrorContext(
  config: ClickHouseConfig,
  workspace: string,
  traceId: string,
): Promise<ErrorContext> {
  const rows = await selectLogRows(
    config,
    `
      SELECT ${LOG_ROW_SELECT}
      FROM logs
      WHERE workspace = {workspace:String}
        AND trace_id = {traceId:String}
      ORDER BY timestamp ASC
      LIMIT {limit:UInt32}
    `,
    { limit: MAX_ROWS, traceId, workspace },
  );

  return { rows, traceId };
}

async function runSql(
  config: ClickHouseConfig,
  query: string,
): Promise<unknown[]> {
  assertReadOnly(query);

  const client = toClient(config);
  const rows = await client
    .query({ format: "JSONEachRow", query })
    .then((r) => r.json<Record<string, unknown>>());

  await client.close();

  return rows;
}

async function selectLogRows(
  config: ClickHouseConfig,
  query: string,
  params: Record<string, string | number>,
): Promise<LogRowLite[]> {
  const client = toClient(config);
  const rows = await client
    .query({ format: "JSONEachRow", query, query_params: params })
    .then((r) => r.json<LogRowLite & { statusCode: string | number }>());

  await client.close();

  return rows.map((row) => ({ ...row, statusCode: Number(row.statusCode) }));
}

function toClient(config: ClickHouseConfig): ClickHouseClient {
  return createClient({
    database: config.database,
    password: config.password,
    url: config.url,
    username: config.user,
  });
}

function assertReadOnly(query: string): void {
  const lower = query.toLowerCase();

  for (const keyword of WRITE_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(lower)) {
      throw new Error(`clickhouse.runSql: write keyword '${keyword}' not allowed`);
    }
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 50;
  }
  return Math.min(Math.trunc(limit), MAX_ROWS);
}

function shortenSignature(signature: string): string {
  const lastPipe = signature.lastIndexOf("|");
  const tail = lastPipe >= 0 ? signature.slice(lastPipe + 1) : signature;
  return tail.slice(0, 120);
}

const LOG_ROW_SELECT = `
  timestamp,
  service,
  level,
  message,
  route,
  status_code AS statusCode,
  trace_id AS traceId,
  user_id AS userId,
  stack_trace AS stackTrace,
  deploy_id AS deployId
`;
