/**
 * Frozen WebSocket event contract between the workspace DO and the dashboard.
 * Both `apps/agent` (producer) and `apps/dashboard` (consumer) import from here.
 *
 * Design:
 * - Every message has a `type` discriminator.
 * - Every message carries an `incidentId` once an incident exists (omitted for
 *   connection-level pings, absent state is `IDLE`).
 * - Timestamps are ISO strings so the UI can render without extra parsing.
 *
 * Do not remove fields without bumping the `PROTOCOL_VERSION` and updating the
 * dashboard. Adding optional fields is safe.
 */

export const PROTOCOL_VERSION = 1 as const;

export type IncidentState =
  | "IDLE"
  | "TRIAGE"
  | "GATHER"
  | "HYPOTHESIZE"
  | "PATCH"
  | "PR"
  | "MONITOR";

export const INCIDENT_STATES: readonly IncidentState[] = [
  "TRIAGE",
  "GATHER",
  "HYPOTHESIZE",
  "PATCH",
  "PR",
  "MONITOR",
];

/** Client -> server. */
export type ClientMessage =
  | { type: "ping" }
  | { type: "subscribe"; incidentId?: string };

/** Server -> client. */
export type ServerMessage =
  | HelloMsg
  | PongMsg
  | StateMsg
  | IncidentStartedMsg
  | IncidentResolvedMsg
  | IncidentOutOfScopeMsg
  | IncidentResetMsg
  | SignalMsg
  | ToolCallMsg
  | ToolResultMsg
  | TokenMsg
  | DiffMsg
  | PrUrlMsg
  | LogMsg
  | ErrorMsg;

export interface HelloMsg {
  type: "hello";
  protocol: typeof PROTOCOL_VERSION;
  state: IncidentState;
  incidentId?: string;
  ts: string;
}

export interface PongMsg {
  type: "pong";
  ts: string;
}

export interface StateMsg {
  type: "state";
  state: IncidentState;
  incidentId?: string;
  ts: string;
}

export interface IncidentStartedMsg {
  type: "incident_started";
  incidentId: string;
  signature: string;
  service: string;
  errorClass: string;
  message: string;
  ts: string;
}

export interface IncidentResolvedMsg {
  type: "incident_resolved";
  incidentId: string;
  resolution: "fixed" | "escalated" | "timed_out";
  ts: string;
}

export interface IncidentOutOfScopeMsg {
  type: "incident_out_of_scope";
  incidentId: string;
  reason: string;
  ts: string;
}

export interface IncidentResetMsg {
  type: "incident_reset";
  state: IncidentState;
  ts: string;
}

export interface SignalMsg {
  type: "signal";
  incidentId?: string;
  signature: string;
  service: string;
  errorClass: string;
  message: string;
  statusCode: number;
  route: string;
  ts: string;
}

export interface ToolCallMsg {
  type: "tool_call";
  incidentId: string;
  callId: string;
  provider: "state" | "git" | "clickhouse";
  tool: string;
  /** JSON-serializable arguments; sensitive fields must be redacted by the producer. */
  args: Record<string, unknown>;
  ts: string;
}

export interface ToolResultMsg {
  type: "tool_result";
  incidentId: string;
  callId: string;
  ok: boolean;
  /** Summary safe to render; detail may be truncated. */
  summary: string;
  detail?: unknown;
  ts: string;
}

export interface TokenMsg {
  type: "token";
  incidentId: string;
  /** Matches the turn index inside HYPOTHESIZE (0-based). */
  turn: number;
  chunk: string;
  ts: string;
}

export interface DiffMsg {
  type: "diff";
  incidentId: string;
  /** Unified diff. */
  patch: string;
  files: string[];
  ts: string;
}

export interface PrUrlMsg {
  type: "pr_url";
  incidentId: string;
  url: string;
  number: number;
  ts: string;
}

export interface LogMsg {
  type: "log";
  incidentId?: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: Record<string, unknown>;
  ts: string;
}

export interface ErrorMsg {
  type: "error";
  incidentId?: string;
  message: string;
  ts: string;
}

export type ServerMessageType = ServerMessage["type"];
