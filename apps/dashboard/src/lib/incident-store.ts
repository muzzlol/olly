import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  IncidentOutOfScopeMsg,
  IncidentResolvedMsg,
  IncidentStartedMsg,
  IncidentState,
  ServerMessage,
  ToolCallMsg,
  ToolResultMsg,
} from "../../../../lib/ws-events.ts";

/**
 * A single renderable row in the event stream. We flatten the incoming
 * `ServerMessage`s into a discriminated union so the UI can render each row
 * with a pure switch.
 *
 * Token chunks are coalesced by `turn`: consecutive token messages with the
 * same turn append into one `token_stream` entry rather than producing N rows.
 */
export type StreamEntry =
  | { kind: "state"; id: string; ts: string; from: IncidentState; to: IncidentState }
  | { kind: "signal"; id: string; ts: string; msg: Extract<ServerMessage, { type: "signal" }> }
  | { kind: "incident_started"; id: string; ts: string; msg: IncidentStartedMsg }
  | { kind: "incident_resolved"; id: string; ts: string; msg: IncidentResolvedMsg }
  | { kind: "incident_out_of_scope"; id: string; ts: string; msg: IncidentOutOfScopeMsg }
  | { kind: "tool"; id: string; ts: string; call: ToolCallMsg; result?: ToolResultMsg }
  | { kind: "token_stream"; id: string; ts: string; turn: number; text: string }
  | { kind: "diff"; id: string; ts: string; msg: Extract<ServerMessage, { type: "diff" }> }
  | { kind: "pr_url"; id: string; ts: string; msg: Extract<ServerMessage, { type: "pr_url" }> }
  | { kind: "log"; id: string; ts: string; msg: Extract<ServerMessage, { type: "log" }> }
  | { kind: "error"; id: string; ts: string; msg: Extract<ServerMessage, { type: "error" }> };

/** Current banner state: most recently started incident + optional terminal outcome. */
export interface IncidentBanner {
  started: IncidentStartedMsg;
  resolved?: IncidentResolvedMsg;
  outOfScope?: IncidentOutOfScopeMsg;
  /** When we first entered a non-IDLE state post-banner (for elapsed display). */
  startedAtMs: number;
}

export interface IncidentStore {
  state: IncidentState;
  incidentId?: string;
  entries: StreamEntry[];
  /** Counter that keeps StreamEntry ids monotonic across a session. */
  nextId: number;
  /** `callId` -> entry index, so results can attach to their call. */
  toolIndex: Record<string, number>;
  prUrl?: string;
  lastProtocol?: number;
  banner?: IncidentBanner;
  /** Timestamp (ms) when `state` was last changed — drives per-state elapsed. */
  stateEnteredAtMs: number;
}

/** Render cap. Any entries beyond this are dropped from the head. */
export const MAX_ENTRIES = 500;

type Action =
  | { type: "reset" }
  | { type: "hydrate"; snapshot: IncidentStore }
  | { type: "ingest"; msg: ServerMessage };

function initial(): IncidentStore {
  return {
    state: "IDLE",
    entries: [],
    nextId: 1,
    toolIndex: {},
    stateEnteredAtMs: Date.now(),
  };
}

function nextId(store: IncidentStore): { id: string; nextId: number } {
  return { id: `e${store.nextId}`, nextId: store.nextId + 1 };
}

/**
 * Append an entry, enforcing the MAX_ENTRIES cap. When we drop from the head
 * we also rebuild `toolIndex` (indices shift) so `tool_result` attachment
 * still resolves correctly for calls that survived the trim.
 */
function appendEntry(store: IncidentStore, entry: StreamEntry): IncidentStore {
  const merged = [...store.entries, entry];
  if (merged.length <= MAX_ENTRIES) {
    return { ...store, entries: merged };
  }
  const drop = merged.length - MAX_ENTRIES;
  const trimmed = merged.slice(drop);
  const rebuilt: Record<string, number> = {};
  for (let i = 0; i < trimmed.length; i++) {
    const e = trimmed[i]!;
    if (e.kind === "tool") rebuilt[e.call.callId] = i;
  }
  return { ...store, entries: trimmed, toolIndex: rebuilt };
}

function reducer(store: IncidentStore, action: Action): IncidentStore {
  if (action.type === "reset") return initial();
  if (action.type === "hydrate") return action.snapshot;

  const msg = action.msg;

  if (msg.type === "hello") {
    return {
      ...store,
      state: msg.state,
      incidentId: msg.incidentId ?? store.incidentId,
      lastProtocol: msg.protocol,
    };
  }

  if (msg.type === "pong") return store;

  if (msg.type === "state") {
    const slot = nextId(store);
    const entry: StreamEntry = {
      kind: "state",
      id: slot.id,
      ts: msg.ts,
      from: store.state,
      to: msg.state,
    };
    const appended = appendEntry(store, entry);
    return {
      ...appended,
      state: msg.state,
      incidentId: msg.incidentId ?? store.incidentId,
      nextId: slot.nextId,
      stateEnteredAtMs: Date.now(),
    };
  }

  if (msg.type === "signal") {
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "signal", id: slot.id, ts: msg.ts, msg,
    });
    return { ...appended, nextId: slot.nextId };
  }

  if (msg.type === "incident_started") {
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "incident_started", id: slot.id, ts: msg.ts, msg,
    });
    return {
      ...appended,
      incidentId: msg.incidentId,
      nextId: slot.nextId,
      banner: { started: msg, startedAtMs: Date.now() },
    };
  }

  if (msg.type === "incident_resolved") {
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "incident_resolved", id: slot.id, ts: msg.ts, msg,
    });
    const banner = store.banner
      ? { ...store.banner, resolved: msg }
      : store.banner;
    return { ...appended, nextId: slot.nextId, banner };
  }

  if (msg.type === "incident_out_of_scope") {
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "incident_out_of_scope", id: slot.id, ts: msg.ts, msg,
    });
    const banner = store.banner
      ? { ...store.banner, outOfScope: msg }
      : store.banner;
    return { ...appended, nextId: slot.nextId, banner };
  }

  if (msg.type === "incident_reset") return initial();

  if (msg.type === "tool_call") {
    const slot = nextId(store);
    const entry: StreamEntry = {
      kind: "tool", id: slot.id, ts: msg.ts, call: msg,
    };
    const beforeLen = store.entries.length;
    const appended = appendEntry(store, entry);
    // Compute index of the just-appended entry (could have been trimmed).
    const idx = Math.min(beforeLen, appended.entries.length - 1);
    return {
      ...appended,
      nextId: slot.nextId,
      toolIndex: { ...appended.toolIndex, [msg.callId]: idx },
    };
  }

  if (msg.type === "tool_result") {
    const idx = store.toolIndex[msg.callId];
    if (idx === undefined) {
      const slot = nextId(store);
      const appended = appendEntry(store, {
        kind: "tool",
        id: slot.id,
        ts: msg.ts,
        call: synthCall(msg),
        result: msg,
      });
      return { ...appended, nextId: slot.nextId };
    }
    const copy = store.entries.slice();
    const prior = copy[idx];
    if (prior && prior.kind === "tool") copy[idx] = { ...prior, result: msg };
    return { ...store, entries: copy };
  }

  if (msg.type === "token") {
    const tail = store.entries[store.entries.length - 1];
    if (tail && tail.kind === "token_stream" && tail.turn === msg.turn) {
      const copy = store.entries.slice();
      copy[copy.length - 1] = { ...tail, text: tail.text + msg.chunk };
      return { ...store, entries: copy };
    }
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "token_stream",
      id: slot.id,
      ts: msg.ts,
      turn: msg.turn,
      text: msg.chunk,
    });
    return { ...appended, nextId: slot.nextId };
  }

  if (msg.type === "diff") {
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "diff", id: slot.id, ts: msg.ts, msg,
    });
    return { ...appended, nextId: slot.nextId };
  }

  if (msg.type === "pr_url") {
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "pr_url", id: slot.id, ts: msg.ts, msg,
    });
    return { ...appended, prUrl: msg.url, nextId: slot.nextId };
  }

  if (msg.type === "log") {
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "log", id: slot.id, ts: msg.ts, msg,
    });
    return { ...appended, nextId: slot.nextId };
  }

  if (msg.type === "error") {
    const slot = nextId(store);
    const appended = appendEntry(store, {
      kind: "error", id: slot.id, ts: msg.ts, msg,
    });
    return { ...appended, nextId: slot.nextId };
  }

  return store;
}

function synthCall(result: ToolResultMsg): ToolCallMsg {
  return {
    type: "tool_call",
    incidentId: result.incidentId,
    callId: result.callId,
    provider: "state",
    tool: "(unknown)",
    args: {},
    ts: result.ts,
  };
}

/**
 * SessionStorage persistence. Keyed by incidentId so a refresh during a live
 * incident keeps the full event stream and banner. We persist the whole
 * reducer snapshot (already capped at MAX_ENTRIES) which is small enough for
 * the session quota.
 */
const STORAGE_PREFIX = "olly:incident:";
const STORAGE_INDEX = "olly:incident:lastId";

function storageKey(incidentId: string): string {
  return `${STORAGE_PREFIX}${incidentId}`;
}

function loadSnapshot(incidentId: string): IncidentStore | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(storageKey(incidentId));
  if (!raw) return null;
  const parsed = safeJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const snap = parsed as IncidentStore;
  if (!Array.isArray(snap.entries)) return null;
  // stateEnteredAtMs must be numeric; reset if missing for backwards compat.
  if (typeof snap.stateEnteredAtMs !== "number") {
    snap.stateEnteredAtMs = Date.now();
  }
  return snap;
}

function saveSnapshot(store: IncidentStore): void {
  if (typeof sessionStorage === "undefined") return;
  const id = store.incidentId;
  if (!id) return;
  // JSON.stringify never throws for our plain data, but sessionStorage can on
  // quota overflow — we ignore silently rather than wrap in try/catch.
  const raw = JSON.stringify(store);
  sessionStorage.setItem(storageKey(id), raw);
  sessionStorage.setItem(STORAGE_INDEX, id);
}

function loadLastSnapshot(): IncidentStore | null {
  if (typeof sessionStorage === "undefined") return null;
  const id = sessionStorage.getItem(STORAGE_INDEX);
  if (!id) return null;
  return loadSnapshot(id);
}

function safeJson(raw: string): unknown {
  const first = raw.charAt(0);
  if (first !== "{" && first !== "[") return null;
  // JSON.parse throws on malformed input; one contained try/catch is
  // cleaner than a streaming parser.
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Hook variant used by the dashboard. `mockMode` disables persistence
 * (scripted replays are ephemeral and shouldn't survive a refresh).
 */
export function useIncidentStore(mockMode: boolean) {
  const [store, dispatch] = useReducer(reducer, undefined, () => {
    const snap = loadLastSnapshot();
    return snap ?? initial();
  });
  const mockRef = useRef(mockMode);
  mockRef.current = mockMode;

  const ingest = useCallback((msg: ServerMessage) => {
    dispatch({ type: "ingest", msg });
  }, []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  // Persist after every mutation, but never while the mock scenario is
  // playing — those events are fake and should not leak into real sessions.
  useEffect(() => {
    if (mockRef.current) return;
    saveSnapshot(store);
  }, [store]);

  return { store, ingest, reset };
}
