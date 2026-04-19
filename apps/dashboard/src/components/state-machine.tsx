import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import type { IncidentState } from "../../../../lib/ws-events.ts";
import { INCIDENT_STATES } from "../../../../lib/ws-events.ts";

interface Props {
  current: IncidentState;
  /** ms timestamp of when `current` was entered — drives per-state elapsed. */
  stateEnteredAtMs: number;
  /** When true, pin an amber "out of scope" badge alongside the state pill. */
  outOfScope: boolean;
  /** Whether an incident is currently running (drives elapsed display). */
  incidentActive: boolean;
}

interface Node {
  name: IncidentState;
  cx: number;
  cy: number;
}

const WIDTH = 520;
const HEIGHT = 640;
const NODE_RADIUS = 46;

function layout(): Node[] {
  const margin = 80;
  const gap = (HEIGHT - margin * 2) / (INCIDENT_STATES.length - 1);
  return INCIDENT_STATES.map((name, i) => ({
    name,
    cx: WIDTH / 2,
    cy: margin + gap * i,
  }));
}

const NODES = layout();

function terminalIndex(state: IncidentState): number {
  const i = INCIDENT_STATES.indexOf(state);
  return i < 0 ? -1 : i;
}

/**
 * Re-render once per second while an incident is active so the "TRIAGE 4.2s"
 * elapsed counter ticks visibly. We intentionally use a coarse 250ms tick so
 * the tenths-of-seconds number is smooth.
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, [active]);
  return now;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function StateMachine({
  current, stateEnteredAtMs, outOfScope, incidentActive,
}: Props) {
  const activeIdx = terminalIndex(current);
  const isIdle = current === "IDLE";
  const now = useTicker(incidentActive);
  const elapsed = formatElapsed(now - stateEnteredAtMs);

  return (
    <div
      className="flex h-full w-full flex-col gap-4 p-6"
      // Fixed min-width prevents the left pane from collapsing during the
      // initial React mount (CLS guard).
      style={{ minWidth: 340 }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-muted-foreground">
          Incident state
        </div>
        <div className="flex items-center gap-2">
          {outOfScope && (
            <div className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-200">
              out of scope
            </div>
          )}
          <div
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              isIdle
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-200",
            )}
          >
            {isIdle
              ? "IDLE"
              : incidentActive
                ? `${current} · ${elapsed}`
                : current}
          </div>
        </div>
      </div>

      <div className="relative flex-1" style={{ minHeight: 400 }}>
        {isIdle && !incidentActive && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-border/60 bg-card/40 px-3 py-1 text-[11px] text-muted-foreground">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary/70" />
              </span>
              waiting for signal
            </div>
          </div>
        )}
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          className="h-full w-full"
          // Fixed aspect ratio keeps SVG from jumping as the page hydrates.
          width={WIDTH}
          height={HEIGHT}
          role="img"
          aria-label="Incident state machine"
        >
          <defs>
            <marker
              id="olly-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 Z" fill="currentColor" />
            </marker>
          </defs>

          {NODES.slice(0, -1).map((n, i) => {
            const next = NODES[i + 1]!;
            const isPast = activeIdx > i;
            const isPending = activeIdx <= i;
            // The "active transition" is the edge pointing INTO the active
            // node. We pulse a small dot along it to suggest progress.
            const isActiveEdge = activeIdx === i + 1 && incidentActive;
            const y1 = n.cy + NODE_RADIUS;
            const y2 = next.cy - NODE_RADIUS;
            return (
              <g key={`edge-${n.name}`}>
                <line
                  x1={n.cx}
                  y1={y1}
                  x2={next.cx}
                  y2={y2}
                  strokeWidth={2}
                  strokeDasharray={isPending ? "4 4" : undefined}
                  markerEnd="url(#olly-arrow)"
                  className={cn(
                    "transition-colors",
                    isPast
                      ? "stroke-foreground/70 text-foreground/70"
                      : isActiveEdge
                        ? "stroke-primary text-primary"
                        : "stroke-muted-foreground/40 text-muted-foreground/40",
                  )}
                />
                {isActiveEdge && (
                  <circle cx={n.cx} r={3} className="fill-primary">
                    <animate
                      attributeName="cy"
                      values={`${y1};${y2};${y1}`}
                      dur="1.4s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0;1;0"
                      dur="1.4s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}
              </g>
            );
          })}

          {NODES.map((n, i) => {
            const active = i === activeIdx;
            const past = i < activeIdx;
            return (
              <g key={n.name}>
                <circle
                  cx={n.cx}
                  cy={n.cy}
                  r={NODE_RADIUS}
                  className={cn(
                    "transition-colors",
                    active
                      ? "fill-primary/15 stroke-primary"
                      : past
                        ? "fill-muted/50 stroke-muted-foreground/60"
                        : "fill-card stroke-border",
                  )}
                  strokeWidth={active ? 2.5 : 1.5}
                />
                {active && (
                  <circle
                    cx={n.cx}
                    cy={n.cy}
                    r={NODE_RADIUS + 8}
                    fill="none"
                    className="stroke-primary/50"
                    strokeWidth={1}
                  >
                    <animate
                      attributeName="r"
                      values={`${NODE_RADIUS + 2};${NODE_RADIUS + 14};${NODE_RADIUS + 2}`}
                      dur="1.8s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.6;0;0.6"
                      dur="1.8s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}
                <text
                  x={n.cx}
                  y={active && incidentActive ? n.cy + 1 : n.cy + 5}
                  textAnchor="middle"
                  className={cn(
                    "select-none text-[13px] font-semibold tracking-wide",
                    active
                      ? "fill-primary"
                      : past
                        ? "fill-foreground"
                        : "fill-muted-foreground",
                  )}
                >
                  {n.name}
                </text>
                {active && incidentActive && (
                  <text
                    x={n.cx}
                    y={n.cy + 18}
                    textAnchor="middle"
                    className="select-none fill-primary/70 font-mono text-[10px]"
                  >
                    {elapsed}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
