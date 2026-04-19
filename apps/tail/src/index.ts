import { createClient } from "@clickhouse/client-web";
import {
  getDeployIdFromScriptVersion,
  getDeployIdSource,
  getIncidentSignature,
} from "../../../lib/incident.ts";
import { createLogger } from "../../../lib/log.ts";
import type { IncidentSignatureSource } from "../../../lib/incident.ts";

export interface Env {
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_PASSWORD: string;
  CLICKHOUSE_DATABASE: string;
  AGENT_URL: string;
}

interface LogRow {
  readonly timestamp: string;
  readonly workspace: string;
  readonly service: string;
  readonly level: string;
  readonly message: string;
  readonly stack_trace: string;
  readonly status_code: number;
  readonly route: string;
  readonly deploy_id: string;
  readonly trace_id: string;
  readonly user_id: string;
  readonly attrs: Record<string, string>;
}

interface SignalEvent {
  readonly errorClass: string;
  readonly timestamp: string;
  readonly service: string;
  readonly level: string;
  readonly message: string;
  readonly stackTrace: string;
  readonly statusCode: number;
  readonly route: string;
  readonly deployId: string;
  readonly signature: string;
  readonly signatureSource: IncidentSignatureSource;
  readonly traceId: string;
}

interface RequestInfo {
  readonly method: string;
  readonly url: string;
  readonly route: string;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
}

interface RowInput {
  readonly attrs?: Record<string, unknown>;
  readonly deployId?: string;
  readonly level: string;
  readonly message: string;
  readonly route?: string;
  readonly service?: string;
  readonly stackTrace?: string;
  readonly statusCode?: number;
  readonly timestamp: number | null;
  readonly traceId?: string;
  readonly userId?: string;
}

const MAX_SIGNAL_EVENTS = 20;
const SEVERE_LEVELS = new Set(["error", "fatal"]);
const SIGNAL_URL = "https://workspace/signal";
const WORKSPACE_NAME = "default";
const log = createLogger("olly-tail");

const handler: ExportedHandler<Env> = {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const outcomes = [...new Set(events.map((item) => item.outcome))];
    const scripts = [
      ...new Set(
        events.flatMap((item) =>
          item.scriptName === null ? [] : [item.scriptName],
        ),
      ),
    ];
    const rows = events.flatMap((item) => toRows(item));
    const signals = toSignalEvents(rows);
    const [insertResult, signalResult] = await Promise.allSettled([
      insertRows(env, rows),
      signals.length === 0 ? Promise.resolve() : signalAgent(env, signals),
    ]);

    if (insertResult.status === "rejected") {
      log.error("tail.batch_insert_failed", {
        error: toError(insertResult.reason),
        eventCount: events.length,
        rowCount: rows.length,
        outcomes,
        scripts,
      });
      throw toError(insertResult.reason);
    }

    if (signalResult.status === "rejected") {
      log.error("tail.signal_failed", {
        error: toError(signalResult.reason),
        signalCount: signals.length,
      });
    }

    log.info("tail.batch_processed", {
      eventCount: events.length,
      rowCount: rows.length,
      signalCount: signals.length,
      outcomes,
      scripts,
    });
  },
};

export default handler;

function toRows(item: TraceItem): LogRow[] {
  const request = getRequestInfo(item);
  const rows: LogRow[] = [];
  const requestRow = toRequestRow(item, request);

  if (requestRow) {
    rows.push(requestRow);
  }

  for (const entry of item.logs) {
    rows.push(toLogRow(item, entry, request));
  }

  for (const entry of item.exceptions) {
    rows.push(toExceptionRow(item, entry, request));
  }

  if (rows.length > 0) {
    return rows;
  }

  return [toFallbackRow(item, request)];
}

function toRequestRow(item: TraceItem, request: RequestInfo | null): LogRow | null {
  if (!request) {
    return null;
  }

  const level = request.statusCode >= 500 || item.outcome === "exception"
    ? "error"
    : "info";
  const status = request.statusCode > 0 ? ` -> ${request.statusCode}` : "";

  return buildRow(item, "request", request, {
    attrs: {
      method: request.method,
      outcome: item.outcome,
      url: request.url,
    },
    level,
    message: `${request.method} ${request.route}${status} (${item.outcome})`,
    statusCode: request.statusCode,
    timestamp: item.eventTimestamp,
    traceId: getTraceId(request),
  });
}

function toLogRow(
  item: TraceItem,
  entry: TraceLog,
  request: RequestInfo | null,
): LogRow {
  const raw = normalizeMessage(entry.message);
  const fields = parseStructuredFields(raw);
  const statusCode = readNumber(fields, ["status_code", "statusCode"]);

  return buildRow(item, "log", request, {
    attrs: fields
      ? {
          ...omitKnownFields(fields),
          raw_message: raw,
        }
      : undefined,
    deployId: readString(fields, ["deploy_id", "deployId"]),
    level: readString(fields, ["level"]) ?? entry.level,
    message: readString(fields, ["event", "message"]) ?? raw,
    route: readString(fields, ["route"]),
    service: readString(fields, ["service"]),
    stackTrace: readStackTrace(fields),
    statusCode,
    timestamp: entry.timestamp,
    traceId: readString(fields, ["trace_id", "traceId"]) ?? getTraceId(request),
    userId: readString(fields, ["user_id", "userId"]),
  });
}

function toExceptionRow(
  item: TraceItem,
  entry: TraceException,
  request: RequestInfo | null,
): LogRow {
  return buildRow(item, "exception", request, {
    attrs: {
      exception_name: entry.name,
    },
    level: "error",
    message: entry.message,
    stackTrace: entry.stack,
    timestamp: entry.timestamp,
    traceId: getTraceId(request),
  });
}

function toFallbackRow(item: TraceItem, request: RequestInfo | null): LogRow {
  return buildRow(item, "event", request, {
    attrs: {
      outcome: item.outcome,
    },
    level: item.outcome === "exception" ? "error" : "info",
    message: `${getEventKind(item)} (${item.outcome})`,
    timestamp: item.eventTimestamp,
    traceId: getTraceId(request),
  });
}

function buildRow(
  item: TraceItem,
  kind: string,
  request: RequestInfo | null,
  input: RowInput,
): LogRow {
  return {
    timestamp: toTimestamp(input.timestamp),
    workspace: WORKSPACE_NAME,
    service: input.service ?? getService(item),
    level: normalizeLevel(input.level),
    message: input.message || kind,
    stack_trace: input.stackTrace ?? "",
    status_code: toStatusCode(input.statusCode ?? request?.statusCode ?? 0),
    route: input.route ?? request?.route ?? "",
    deploy_id: input.deployId ?? getDeployId(item),
    trace_id: input.traceId ?? getTraceId(request),
    user_id: input.userId ?? "",
    attrs: toAttrMap({
      kind,
      deploy_source: getDeployIdSource(item.scriptVersion),
      durable_object_id: item.durableObjectId,
      entrypoint: item.entrypoint,
      execution_model: item.executionModel,
      outcome: item.outcome,
      script_name: item.scriptName,
      script_tags: item.scriptTags,
      script_version_id: item.scriptVersion?.id,
      script_version_message: item.scriptVersion?.message,
      script_version_tag: item.scriptVersion?.tag,
      ...input.attrs,
    }),
  };
}

async function insertRows(env: Env, rows: LogRow[]): Promise<void> {
  const client = createClient({
    database: env.CLICKHOUSE_DATABASE,
    password: env.CLICKHOUSE_PASSWORD,
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
  });

  await client.insert({
    format: "JSONEachRow",
    table: "logs",
    values: rows,
  });

  await client.close();
}

async function signalAgent(
  env: Env,
  signals: SignalEvent[],
): Promise<void> {
  if (env.AGENT_URL === "") {
    throw new Error("missing AGENT_URL");
  }

  const response = await fetch(new URL("/signal", env.AGENT_URL), {
    body: JSON.stringify({
      events: signals,
      workspace: WORKSPACE_NAME,
    }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`workspace signal failed with ${response.status}`);
  }
}

function toSignalEvents(rows: LogRow[]): SignalEvent[] {
  const seen = new Set<string>();
  const signals: SignalEvent[] = [];

  for (const row of rows) {
    if (!isSevereRow(row)) {
      continue;
    }

    const signal = toSignalEvent(row);
    const key = [row.trace_id, signal.signature].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    signals.push(signal);

    if (signals.length === MAX_SIGNAL_EVENTS) {
      return signals;
    }
  }

  return signals;
}

function toSignalEvent(row: LogRow): SignalEvent {
  const errorClass = readString(row.attrs, [
    "exception_name",
    "error_class",
    "errorClass",
    "error_name",
    "errorName",
  ]);
  const signature = getIncidentSignature({
    errorClass,
    message: row.message,
    route: row.route,
    service: row.service,
    stackTrace: row.stack_trace,
    statusCode: row.status_code,
  });

  return {
    deployId: row.deploy_id,
    errorClass: signature.errorClass,
    level: row.level,
    message: row.message,
    route: row.route,
    service: row.service,
    signature: signature.key,
    signatureSource: signature.source,
    stackTrace: row.stack_trace,
    statusCode: row.status_code,
    timestamp: row.timestamp,
    traceId: row.trace_id,
  };
}

function isSevereRow(row: LogRow): boolean {
  if (SEVERE_LEVELS.has(row.level)) {
    return true;
  }

  if (row.status_code >= 500) {
    return true;
  }

  return row.stack_trace !== "";
}

function getRequestInfo(item: TraceItem): RequestInfo | null {
  if (!isFetchEvent(item.event)) {
    return null;
  }

  const request = item.event.request.getUnredacted();

  return {
    headers: request.headers,
    method: request.method,
    route: new URL(request.url).pathname,
    statusCode: toStatusCode(item.event.response?.status ?? 0),
    url: request.url,
  };
}

function getEventKind(item: TraceItem): string {
  const event = item.event;

  if (!event) {
    return "trace";
  }

  if ("request" in event) {
    return "fetch";
  }

  if ("rpcMethod" in event) {
    return "rpc";
  }

  if ("queue" in event) {
    return "queue";
  }

  if ("cron" in event) {
    return "scheduled";
  }

  if ("scheduledTime" in event) {
    return "alarm";
  }

  if ("mailFrom" in event) {
    return "email";
  }

  if ("consumedEvents" in event) {
    return "tail";
  }

  if ("getWebSocketEvent" in event) {
    return "websocket";
  }

  return "custom";
}

function getService(item: TraceItem): string {
  return item.scriptName ?? "unknown";
}

function getDeployId(item: TraceItem): string {
  return getDeployIdFromScriptVersion(item.scriptVersion);
}

function getTraceId(request: RequestInfo | null): string {
  if (!request) {
    return "";
  }

  const cfRay = readHeader(request.headers, "cf-ray");

  if (cfRay) {
    return cfRay;
  }

  const traceParent = readHeader(request.headers, "traceparent");

  if (traceParent) {
    const parts = traceParent.split("-");

    if (parts.length >= 2) {
      return parts[1] ?? "";
    }
  }

  return (
    readHeader(request.headers, "x-trace-id") ||
    readHeader(request.headers, "x-request-id")
  );
}

function readHeader(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return "";
}

function parseStructuredFields(message: string): Record<string, unknown> | null {
  if (!message.startsWith("{")) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(message) as unknown;
  } catch {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function omitKnownFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (KNOWN_FIELD_KEYS.has(key)) {
      continue;
    }

    out[key] = value;
  }

  return out;
}

function normalizeMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map((value) => stringifyValue(value)).join(" ");
  }

  return stringifyValue(message);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function normalizeLevel(level: string): string {
  const value = level.toLowerCase();

  if (value === "log") {
    return "info";
  }

  if (value === "warning") {
    return "warn";
  }

  return value;
}

function readString(
  fields: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!fields) {
    return undefined;
  }

  for (const key of keys) {
    const value = fields[key];

    if (typeof value === "string" && value !== "") {
      return value;
    }
  }

  return undefined;
}

function readNumber(
  fields: Record<string, unknown> | null,
  keys: string[],
): number | undefined {
  if (!fields) {
    return undefined;
  }

  for (const key of keys) {
    const value = fields[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value !== "") {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function readStackTrace(fields: Record<string, unknown> | null): string {
  const stack = readString(fields, ["stack_trace", "stackTrace"]);

  if (stack) {
    return stack;
  }

  const error = fields?.error;

  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "";
  }

  const value = (error as Record<string, unknown>).stack;

  return typeof value === "string" ? value : "";
}

function toAttrMap(fields: Record<string, unknown>): Record<string, string> {
  const attrs: Record<string, string> = {};

  for (const [key, value] of Object.entries(fields)) {
    const text = toAttrValue(value);

    if (text === "") {
      continue;
    }

    attrs[key] = text;
  }

  return attrs;
}

function toAttrValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null || value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}

function toTimestamp(value: number | null): string {
  return new Date(value ?? Date.now()).toISOString();
}

function toStatusCode(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 65535) {
    return 65535;
  }

  return Math.trunc(value);
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  return new Error(String(reason));
}

function isFetchEvent(event: TraceItem["event"]): event is TraceItemFetchEventInfo {
  return event !== null && "request" in event;
}

const KNOWN_FIELD_KEYS = new Set([
  "deployId",
  "deploy_id",
  "level",
  "message",
  "route",
  "service",
  "stackTrace",
  "stack_trace",
  "statusCode",
  "status_code",
  "traceId",
  "trace_id",
  "ts",
  "userId",
  "user_id",
]);
