import { ChevronDown, Loader2, Play, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PROTOCOL_VERSION } from "../../../../lib/ws-events.ts";
import type { WsStatus } from "@/lib/ws";
import type { MockScenario } from "@/lib/mock-stream";

interface Props {
  wsStatus: WsStatus;
  latencyMs: number | null;
  reconnectInMs: number;
  mockActive: boolean;
  triggering: boolean;
  onReplay: (scenario: MockScenario) => void;
  onTriggerDemo: () => void;
}

const SCENARIO_LABELS: Record<MockScenario, string> = {
  short: "Short",
  escalated: "Escalated",
  storm: "Token storm",
};

const SCENARIO_DESCRIPTIONS: Record<MockScenario, string> = {
  short: "Full loop, fixed PR",
  escalated: "Out-of-scope, escalated",
  storm: "250 token chunks",
};

export function Header({
  wsStatus,
  latencyMs,
  reconnectInMs,
  mockActive,
  triggering,
  onReplay,
  onTriggerDemo,
}: Props) {
  return (
    <header className="flex h-14 items-center gap-3 border-b border-border bg-card/40 px-5">
      <div className="flex items-center gap-2">
        <div className="h-2.5 w-2.5 rounded-sm bg-primary" />
        <div className="text-base font-semibold tracking-tight">Olly</div>
        <Badge variant="outline" className="ml-1 border-muted-foreground/30 text-[10px] uppercase">
          protocol v{PROTOCOL_VERSION}
        </Badge>
      </div>

      <div className="ml-3 flex items-center gap-2">
        <ConnectionPill
          status={wsStatus}
          latencyMs={latencyMs}
          reconnectInMs={reconnectInMs}
        />
        {mockActive && (
          <Badge
            variant="outline"
            className="border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200"
          >
            mock replay
          </Badge>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ReplayMenu onSelect={onReplay} />
        <Button
          size="sm"
          onClick={onTriggerDemo}
          disabled={triggering}
          title="Post a live signal to the agent worker"
        >
          {triggering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
          {triggering ? "Triggering…" : "Trigger incident"}
        </Button>
      </div>
    </header>
  );
}

function latencyColor(latency: number): string {
  if (latency < 200) return "bg-emerald-400";
  if (latency < 800) return "bg-amber-400";
  return "bg-rose-400";
}

interface ConnectionProps {
  status: WsStatus;
  latencyMs: number | null;
  reconnectInMs: number;
}

function ConnectionPill({ status, latencyMs, reconnectInMs }: ConnectionProps) {
  if (status === "open") {
    const color = latencyMs === null ? "bg-emerald-400" : latencyColor(latencyMs);
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={cn("h-2 w-2 rounded-full", color)}
          aria-label="connected"
        />
        <span>connected</span>
        {latencyMs !== null && (
          <span className="font-mono tabular-nums">{latencyMs}ms</span>
        )}
      </div>
    );
  }

  if (status === "connecting") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className="h-2 w-2 animate-pulse rounded-full bg-sky-400"
          aria-label="connecting"
        />
        <span>connecting…</span>
      </div>
    );
  }

  // closed — pulse amber with reconnect countdown.
  const seconds = Math.max(0, Math.ceil(reconnectInMs / 1000));
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className="h-2 w-2 animate-pulse rounded-full bg-amber-400"
        aria-label="reconnecting"
      />
      <span>
        reconnecting{seconds > 0 ? ` in ${seconds}s` : "…"}
      </span>
    </div>
  );
}

interface ReplayMenuProps {
  onSelect: (scenario: MockScenario) => void;
}

function ReplayMenu({ onSelect }: ReplayMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative flex items-center">
      <Button
        size="sm"
        variant="outline"
        onClick={() => onSelect("short")}
        className="rounded-r-none border-r-0"
      >
        <Play className="h-3.5 w-3.5" />
        Demo replay
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen((v) => !v)}
        aria-label="choose mock scenario"
        className="rounded-l-none px-2"
      >
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
        />
      </Button>
      {open && (
        <div className="absolute right-0 top-9 z-20 min-w-[220px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {(["short", "escalated", "storm"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => { setOpen(false); onSelect(s); }}
              className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <span className="font-medium">{SCENARIO_LABELS[s]}</span>
              <span className="text-[10px] text-muted-foreground">
                {SCENARIO_DESCRIPTIONS[s]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
