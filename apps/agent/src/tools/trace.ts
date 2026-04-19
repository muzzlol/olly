/**
 * Tool invocation tracer.
 *
 * Wraps any async tool call so that a `tool_call` event is emitted before
 * the tool runs and a matching `tool_result` is emitted after — with a stable
 * `callId` linking the two. The host function never sees secrets: callers
 * must redact sensitive fields in `args` before passing them in.
 *
 * Errors from the tool are captured in the `tool_result` (`ok: false`) and
 * re-thrown so the state machine can decide whether to bail.
 */

import type {
  ServerMessage,
  ToolCallMsg,
  ToolResultMsg,
} from "../../../../lib/ws-events.ts";

export type Provider = ToolCallMsg["provider"];

export type Emit = (msg: ServerMessage) => void;

const MAX_DETAIL_BYTES = 8_000;

export async function traceTool<T>(
  emit: Emit,
  incidentId: string,
  provider: Provider,
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const callId = randomCallId();
  const ts = new Date().toISOString();

  emit({
    args,
    callId,
    incidentId,
    provider,
    tool,
    ts,
    type: "tool_call",
  });

  return fn()
    .then((out) => {
      emit(toResultMsg(incidentId, callId, true, out));
      return out;
    })
    .catch((err: unknown) => {
      emit(toResultMsg(incidentId, callId, false, err));
      throw err;
    });
}

function toResultMsg(
  incidentId: string,
  callId: string,
  ok: boolean,
  value: unknown,
): ToolResultMsg {
  return {
    callId,
    detail: truncateDetail(value),
    incidentId,
    ok,
    summary: summarize(ok, value),
    ts: new Date().toISOString(),
    type: "tool_result",
  };
}

function summarize(ok: boolean, value: unknown): string {
  if (!ok) {
    return toErrorMessage(value);
  }

  if (value === undefined || value === null) {
    return "ok";
  }

  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }

  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object(${keys.slice(0, 4).join(",")}${keys.length > 4 ? "…" : ""})`;
  }

  return String(value);
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

function truncateDetail(value: unknown): unknown {
  const raw = tryStringify(value);

  if (raw === null) {
    return undefined;
  }

  if (raw.length <= MAX_DETAIL_BYTES) {
    return value;
  }

  return `${raw.slice(0, MAX_DETAIL_BYTES)}…(truncated ${raw.length - MAX_DETAIL_BYTES}B)`;
}

function tryStringify(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  return safeJson(value);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v instanceof Error ? { message: v.message, name: v.name } : v,
  ) ?? "null";
}

function randomCallId(): string {
  return crypto.randomUUID();
}
