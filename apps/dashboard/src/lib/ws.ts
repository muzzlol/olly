import { useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  ServerMessage,
} from "../../../../lib/ws-events.ts";

const DEFAULT_URL = "ws://localhost:1337/ws";
const PING_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 5_000;
const LATENCY_WINDOW = 3;

/**
 * Derive the agent WS URL at runtime:
 *  1. `VITE_AGENT_WS_URL` (build-time override) wins if set.
 *  2. In prod (not localhost), swap the dashboard hostname (`*-dashboard-*`)
 *     for the agent hostname (`*-agent-*`) and use wss://. Same CF account,
 *     same stage, predictable naming.
 *  3. Fallback to local dev default.
 */
function deriveProdAgentUrl(): string | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return null;
  if (!host.includes("-dashboard-")) return null;
  const agentHost = host.replace("-dashboard-", "-agent-");
  return `wss://${agentHost}/ws`;
}

/** HTTP base for the agent worker (used by REST calls like /signal). */
export function getAgentHttpBase(): string {
  const ws = resolveUrl();
  if (ws.startsWith("wss://")) return "https://" + ws.slice("wss://".length).replace(/\/ws$/, "");
  if (ws.startsWith("ws://")) return "http://" + ws.slice("ws://".length).replace(/\/ws$/, "");
  return "http://localhost:1337";
}

export type WsStatus = "connecting" | "open" | "closed";

export interface WsHookResult {
  status: WsStatus;
  /** Rolling average round-trip (ms) over last LATENCY_WINDOW ping/pongs, or null. */
  latencyMs: number | null;
  /** When `status === "closed"`, ms until the next reconnect attempt (0 if none queued). */
  reconnectInMs: number;
  send: (msg: ClientMessage) => void;
}

function resolveUrl(): string {
  const env = import.meta.env.VITE_AGENT_WS_URL;
  if (typeof env === "string" && env.length > 0) return env;
  const derived = deriveProdAgentUrl();
  if (derived) return derived;
  return DEFAULT_URL;
}

/**
 * Connect to the agent worker's WebSocket. Auto-reconnects with backoff
 * capped at 5s. Pings every 20s while open and records round-trip latency.
 *
 * @param onMessage invoked with every typed server message received.
 * @param enabled   when false the socket stays closed (used to disable live
 *                  mode while a mock replay is active).
 */
export function useAgentSocket(
  onMessage: (msg: ServerMessage) => void,
  enabled: boolean,
): WsHookResult {
  const [status, setStatus] = useState<WsStatus>("closed");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [reconnectInMs, setReconnectInMs] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      setLatencyMs(null);
      setReconnectInMs(0);
      return;
    }

    let backoff = 250;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let countdownTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    let pingSentAt = 0;
    let samples: number[] = [];

    const clearPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const clearCountdown = () => {
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      setStatus("closed");
      clearPing();
      const delay = Math.min(backoff, MAX_BACKOFF_MS);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      const reconnectAt = Date.now() + delay;
      setReconnectInMs(delay);
      clearCountdown();
      countdownTimer = setInterval(() => {
        const remain = Math.max(0, reconnectAt - Date.now());
        setReconnectInMs(remain);
        if (remain <= 0) clearCountdown();
      }, 100);
      reconnectTimer = setTimeout(connect, delay);
    };

    const sendPing = (ws: WebSocket) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      pingSentAt = Date.now();
      ws.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
    };

    const recordPong = () => {
      if (pingSentAt === 0) return;
      const rtt = Date.now() - pingSentAt;
      pingSentAt = 0;
      samples = [...samples.slice(-(LATENCY_WINDOW - 1)), rtt];
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      setLatencyMs(Math.round(avg));
    };

    const connect = () => {
      if (disposed) return;
      clearCountdown();
      setReconnectInMs(0);
      setStatus("connecting");
      const url = resolveUrl();
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        backoff = 250;
        samples = [];
        setLatencyMs(null);
        setStatus("open");
        // Prime latency on connect so the indicator has a number fast.
        sendPing(ws);
        pingTimer = setInterval(() => sendPing(ws), PING_INTERVAL_MS);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        const parsed = parseServerMessage(ev.data);
        if (!parsed) return;
        if (parsed.type === "pong") recordPong();
        handlerRef.current(parsed);
      };

      ws.onerror = () => { ws.close(); };

      ws.onclose = () => {
        socketRef.current = null;
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      clearPing();
      clearCountdown();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = socketRef.current;
      if (ws) ws.close();
      socketRef.current = null;
    };
  }, [enabled]);

  const send = (msg: ClientMessage) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  return { status, latencyMs, reconnectInMs, send };
}

function parseServerMessage(raw: string): ServerMessage | null {
  const result = safeJson(raw);
  if (!result || typeof result !== "object") return null;
  const candidate = result as Partial<ServerMessage>;
  if (typeof candidate.type !== "string") return null;
  return candidate as ServerMessage;
}

function safeJson(raw: string): unknown {
  const first = raw.charAt(0);
  if (first !== "{" && first !== "[") return null;
  // JSON.parse throws on malformed input; this is the one place try/catch is
  // actually cleaner than alternatives (no streaming parser here).
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
