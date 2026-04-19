import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { IncidentBanner, StreamEntry } from "@/lib/incident-store";

interface Props {
  entries: StreamEntry[];
  banner?: IncidentBanner;
}

/**
 * Max characters of a JSON blob we pretty-print up front. Anything bigger is
 * hidden behind a "show full" affordance so a giant tool_result payload
 * doesn't nuke the layout.
 */
const JSON_INLINE_BUDGET = 4_000;

export function EventStream({ entries, banner }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastSeenLen = useRef(entries.length);
  const [newCount, setNewCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Scroll to the bottom unconditionally (used after auto-follow or button). */
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    followRef.current = true;
    setNewCount(0);
  }, []);

  /** Track whether the user has scrolled away from the tail. */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < 24;
    followRef.current = atBottom;
    if (atBottom) setNewCount(0);
  }, []);

  // Autoscroll / new-count tracker.
  useEffect(() => {
    const delta = entries.length - lastSeenLen.current;
    lastSeenLen.current = entries.length;
    if (delta <= 0) return;
    if (followRef.current) {
      // Defer to after paint so scrollHeight reflects the new row.
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
      });
      return;
    }
    setNewCount((c) => c + delta);
  }, [entries.length]);

  // Keyboard j/k/Enter navigation. Registered on window so it works without
  // the user clicking into the stream first.
  useEffect(() => {
    function handler(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
      }
      if (ev.key !== "j" && ev.key !== "k" && ev.key !== "Enter") return;
      if (entries.length === 0) return;
      ev.preventDefault();
      const idx = cursor ? entries.findIndex((e) => e.id === cursor) : -1;
      if (ev.key === "j") {
        const nextIdx = Math.min(entries.length - 1, idx < 0 ? 0 : idx + 1);
        setCursor(entries[nextIdx]!.id);
        return;
      }
      if (ev.key === "k") {
        const nextIdx = Math.max(0, idx < 0 ? entries.length - 1 : idx - 1);
        setCursor(entries[nextIdx]!.id);
        return;
      }
      if (ev.key === "Enter" && cursor) toggleExpand(cursor);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [entries, cursor, toggleExpand]);

  // Scroll selected cursor into view.
  useEffect(() => {
    if (!cursor) return;
    const el = document.querySelector(`[data-entry-id="${cursor}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [cursor]);

  if (entries.length === 0 && !banner) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center"
        aria-live="polite"
      >
        <div className="text-sm font-medium text-muted-foreground">
          No events yet.
        </div>
        <div className="text-xs text-muted-foreground/70">
          Waiting for the agent. Hit “Demo replay” in the header to preview the
          incident loop.
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto p-4 pr-5"
        aria-live="polite"
        aria-relevant="additions"
        tabIndex={0}
      >
        {banner && <IncidentCard banner={banner} />}
        <div className="mt-3 space-y-3">
          {entries.map((entry) => (
            <Row
              key={entry.id}
              entry={entry}
              selected={cursor === entry.id}
              expanded={expanded.has(entry.id)}
              onToggle={() => toggleExpand(entry.id)}
              onSelect={() => setCursor(entry.id)}
            />
          ))}
        </div>
      </div>
      {newCount > 0 && !followRef.current && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-4 right-6 z-10 flex items-center gap-1.5 rounded-full border border-primary/50 bg-primary/20 px-3 py-1.5 text-xs font-medium text-primary shadow-sm backdrop-blur transition-colors hover:bg-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowDown className="h-3 w-3" />
          {newCount} new {newCount === 1 ? "event" : "events"}
        </button>
      )}
    </div>
  );
}

interface RowProps {
  entry: StreamEntry;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
}

function Row(props: RowProps) {
  const { entry, selected } = props;
  return (
    <div
      data-entry-id={entry.id}
      onClick={props.onSelect}
      className={cn(
        "grid grid-cols-[64px_1fr] items-start gap-2 rounded-md transition-colors",
        selected && "ring-1 ring-ring/60",
      )}
    >
      <div className="pt-2 pl-1 font-mono text-[10px] tabular-nums text-muted-foreground/70">
        {shortTs(entry.ts)}
      </div>
      <div className="min-w-0">
        <RowBody {...props} />
      </div>
    </div>
  );
}

function RowBody({ entry, expanded, onToggle }: RowProps) {
  if (entry.kind === "state") return <StateRow entry={entry} />;
  if (entry.kind === "signal") return <SignalRow entry={entry} />;
  if (entry.kind === "incident_started") return <IncidentStartedRow entry={entry} />;
  if (entry.kind === "incident_resolved") return <IncidentResolvedRow entry={entry} />;
  if (entry.kind === "incident_out_of_scope") return <OutOfScopeRow entry={entry} />;
  if (entry.kind === "tool") return <ToolRow entry={entry} />;
  if (entry.kind === "token_stream") return <TokenRow entry={entry} />;
  if (entry.kind === "diff") return <DiffRow entry={entry} />;
  if (entry.kind === "pr_url") return <PrRow entry={entry} />;
  if (entry.kind === "log") {
    return <LogRow entry={entry} expanded={expanded} onToggle={onToggle} />;
  }
  if (entry.kind === "error") return <ErrorRow entry={entry} />;
  return null;
}

function shortTs(ts: string): string {
  // ISO: yyyy-MM-ddTHH:mm:ss.sssZ — slice HH:mm:ss.ms
  const t = ts.indexOf("T");
  if (t < 0) return ts;
  const rest = ts.slice(t + 1, t + 13);
  return rest.length > 0 ? rest : ts;
}

type WithEntry<K extends StreamEntry["kind"]> = {
  entry: Extract<StreamEntry, { kind: K }>;
};

function StateRow({ entry }: WithEntry<"state">) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <Badge variant="outline" className="border-muted-foreground/30">
        {entry.from}
      </Badge>
      <ChevronRight className="h-3 w-3 text-muted-foreground" />
      <Badge className="bg-primary/15 text-primary border-primary/30" variant="outline">
        {entry.to}
      </Badge>
    </div>
  );
}

function SignalRow({ entry }: WithEntry<"signal">) {
  const m = entry.msg;
  return (
    <div className="rounded-md border border-border bg-card/50 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <Badge variant="secondary" className="uppercase tracking-wide">signal</Badge>
        <span className="text-muted-foreground">{m.service}</span>
      </div>
      <div className="font-mono text-[11px] text-foreground/80">
        {m.errorClass} · {m.route} · status {m.statusCode}
      </div>
      <div className="mt-1 text-muted-foreground">{m.message}</div>
    </div>
  );
}

function IncidentStartedRow({ entry }: WithEntry<"incident_started">) {
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <Badge className="bg-primary/20 text-primary border-primary/40" variant="outline">
          incident started
        </Badge>
      </div>
      <div className="font-mono text-[11px]">{entry.msg.signature}</div>
      <div className="mt-1 text-muted-foreground">{entry.msg.message}</div>
    </div>
  );
}

function IncidentResolvedRow({ entry }: WithEntry<"incident_resolved">) {
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge className="border-emerald-500/40 bg-emerald-500/20 text-emerald-300" variant="outline">
          resolved · {entry.msg.resolution}
        </Badge>
      </div>
    </div>
  );
}

function OutOfScopeRow({ entry }: WithEntry<"incident_out_of_scope">) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <Badge className="border-amber-500/50 bg-amber-500/20 text-amber-200" variant="outline">
          out of scope
        </Badge>
      </div>
      <div className="text-amber-100">{entry.msg.reason}</div>
    </div>
  );
}

function Expandable({
  children, label, defaultOpen = false,
}: {
  children: React.ReactNode;
  label: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        {label}
      </button>
      {open && (
        <div className="mt-1 max-h-80 overflow-auto rounded-md border border-border bg-background p-2">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Safely pretty-prints a value. If the payload is huge, only shows a prefix
 * and exposes a button to render the rest — keeps the event stream usable
 * when the agent returns a multi-MB clickhouse query result by mistake.
 */
function Json({ value }: { value: unknown }) {
  const full = useMemo(() => safeStringify(value), [value]);
  const [showAll, setShowAll] = useState(false);
  const oversized = full.length > JSON_INLINE_BUDGET;
  const visible = !oversized || showAll ? full : full.slice(0, JSON_INLINE_BUDGET);
  return (
    <div>
      <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/80">
        {visible}
        {oversized && !showAll && "\n…"}
      </pre>
      {oversized && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 text-[10px] text-muted-foreground underline hover:text-foreground"
        >
          {showAll
            ? `collapse (${full.length.toLocaleString()} chars)`
            : `show full (${full.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function safeStringify(value: unknown): string {
  // JSON.stringify can throw on BigInt or circular refs. The inline try/catch
  // is the only sane option.
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ToolRow({ entry }: WithEntry<"tool">) {
  const providerColor: Record<typeof entry.call.provider, string> = {
    state: "border-sky-500/30 bg-sky-500/10 text-sky-200",
    git: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200",
    clickhouse: "border-orange-500/30 bg-orange-500/10 text-orange-200",
  };
  const result = entry.result;
  return (
    <div className="rounded-md border border-border bg-card/50 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={providerColor[entry.call.provider]}>
          {entry.call.provider}
        </Badge>
        <span className="font-mono font-medium">{entry.call.tool}</span>
      </div>

      <Expandable label="args">
        <Json value={entry.call.args} />
      </Expandable>

      {result && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                result.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {result.ok ? "ok" : "error"}
            </Badge>
            <span className="text-foreground/80">{result.summary}</span>
          </div>
          {result.detail !== undefined && (
            <Expandable label="detail">
              <Json value={result.detail} />
            </Expandable>
          )}
        </div>
      )}
    </div>
  );
}

function TokenRow({ entry }: WithEntry<"token_stream">) {
  return (
    <div className="rounded-md border border-border/70 bg-card/30 p-3 text-sm leading-relaxed">
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <Badge variant="outline" className="border-muted-foreground/30">
          reasoning · turn {entry.turn}
        </Badge>
      </div>
      <div className="whitespace-pre-wrap text-foreground/90">{entry.text}</div>
    </div>
  );
}

function DiffRow({ entry }: WithEntry<"diff">) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const nav = typeof navigator === "undefined" ? null : navigator;
    if (!nav?.clipboard) return;
    nav.clipboard.writeText(entry.msg.patch).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  }, [entry.msg.patch]);

  return (
    <div className="rounded-md border border-border bg-card/60 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-muted-foreground/30">diff</Badge>
        <span className="text-muted-foreground">
          {entry.msg.files.length}{" "}
          {entry.msg.files.length === 1 ? "file" : "files"}
        </span>
        {entry.msg.files.map((f) => (
          <span key={f} className="font-mono text-[11px] text-muted-foreground">
            {f}
          </span>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 px-2 text-[11px]"
          onClick={onCopy}
          aria-label="copy diff"
        >
          {copied
            ? <><Check className="h-3 w-3" /> copied</>
            : <><Copy className="h-3 w-3" /> copy</>}
        </Button>
      </div>
      <pre className="max-h-[420px] overflow-auto rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed">
        {entry.msg.patch.split("\n").map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line.length === 0 ? " " : line}
          </div>
        ))}
      </pre>
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-muted-foreground";
  }
  if (line.startsWith("@@")) return "olly-diff-hunk";
  if (line.startsWith("+")) return "olly-diff-add";
  if (line.startsWith("-")) return "olly-diff-del";
  if (line.startsWith("diff ")) return "text-muted-foreground";
  return "text-foreground/80";
}

function PrRow({ entry }: WithEntry<"pr_url">) {
  return (
    <div className="rounded-md border border-primary/40 bg-primary/10 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <Badge className="bg-primary/25 text-primary border-primary/40" variant="outline">
          pull request
        </Badge>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="font-mono text-lg font-semibold">#{entry.msg.number}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {entry.msg.url}
          </div>
        </div>
        <Button asChild size="sm">
          <a href={entry.msg.url} target="_blank" rel="noreferrer">
            Open in new tab <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}

/** Colors follow spec: debug=neutral, info=sky, warn=amber, error=rose. */
const LOG_COLORS: Record<string, string> = {
  debug: "border-muted-foreground/30 bg-muted/20 text-muted-foreground",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  error: "border-rose-500/40 bg-rose-500/10 text-rose-200",
};

interface LogRowProps {
  entry: Extract<StreamEntry, { kind: "log" }>;
  expanded: boolean;
  onToggle: () => void;
}

function LogRow({ entry, expanded, onToggle }: LogRowProps) {
  const level = entry.msg.level;
  const hasFields = !!entry.msg.fields && Object.keys(entry.msg.fields).length > 0;
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1.5 text-[11px]",
        LOG_COLORS[level] ?? LOG_COLORS.debug,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="rounded-sm border border-current/30 bg-current/10 px-1.5 text-[9px] uppercase tracking-wider opacity-80">
          {level}
        </span>
        <span className="font-mono">{entry.msg.event}</span>
        {hasFields && (
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); onToggle(); }}
            className="ml-auto flex items-center gap-1 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
            fields
          </button>
        )}
      </div>
      {hasFields && expanded && (
        <div className="mt-1 rounded-md border border-current/20 bg-background/40 p-2">
          <Json value={entry.msg.fields} />
        </div>
      )}
    </div>
  );
}

function ErrorRow({ entry }: WithEntry<"error">) {
  return (
    <div className="rounded-md border border-rose-500/50 bg-rose-500/10 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge className="border-rose-500/50 bg-rose-500/20 text-rose-200" variant="outline">
          error
        </Badge>
      </div>
      <div className="mt-1 text-rose-100">
        {typeof entry.msg.message === "string"
          ? entry.msg.message
          : "(malformed error payload)"}
      </div>
    </div>
  );
}

/**
 * Sticky incident banner. Swaps into a resolved/out-of-scope variant once the
 * incident terminates. Intentionally rendered at the top of the scroll
 * container so it travels with the feed — same screen budget as the event
 * rows, keeps the user oriented while scrolling back.
 */
function IncidentCard({ banner }: { banner: IncidentBanner }) {
  const outOfScope = banner.outOfScope;
  const resolved = banner.resolved;
  const tone = outOfScope
    ? "border-amber-500/50 bg-amber-500/10"
    : resolved
      ? resolved.resolution === "fixed"
        ? "border-emerald-500/40 bg-emerald-500/10"
        : resolved.resolution === "escalated"
          ? "border-amber-500/50 bg-amber-500/10"
          : "border-muted-foreground/40 bg-muted/20"
      : "border-primary/50 bg-primary/10";

  const Icon = resolved
    ? resolved.resolution === "fixed"
      ? CheckCircle2
      : resolved.resolution === "escalated"
        ? XCircle
        : Clock
    : null;

  return (
    <div
      className={cn(
        "sticky top-0 z-[5] rounded-md border p-3 text-xs shadow-sm backdrop-blur transition-colors",
        tone,
      )}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-current/40 bg-current/10">
          {outOfScope
            ? "out of scope"
            : resolved
              ? `resolved · ${resolved.resolution}`
              : "live incident"}
        </Badge>
        {Icon && <Icon className="h-3.5 w-3.5 opacity-80" />}
        <span className="font-mono text-[11px] text-muted-foreground">
          {banner.started.service}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {banner.started.errorClass}
        </span>
      </div>
      <div className="mt-1 font-mono text-[11px]">{banner.started.signature}</div>
      <div className="mt-1 text-foreground/80">{banner.started.message}</div>
      {outOfScope && (
        <div className="mt-2 rounded-sm border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100">
          {outOfScope.reason}
        </div>
      )}
    </div>
  );
}
