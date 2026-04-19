/**
 * PATCH — produce a single-file edit for the target identified in
 * HYPOTHESIZE, apply it to the cloned workspace FS, and emit the unified
 * diff over the WS.
 *
 * Demo mode mirrors `scripts/plant-bug.ts` / `reset-bug.ts`: swap the
 * planted `item.meta.price` back to `item.price` in `src/lib/price.ts`.
 * Prod mode would call the model — deferred here, same deterministic path
 * as demo for MVP reliability.
 */

import type { Workspace } from "@cloudflare/shell";
import { traceTool, type Emit } from "../tools/trace";
import type { DiffMsg, LogMsg } from "../../../../lib/ws-events.ts";

export interface PatchInput {
  readonly incidentId: string;
  readonly emit: Emit;
  readonly workspace: Workspace;
  readonly targetFile: string;
  readonly isDemo: boolean;
}

export interface PatchResult {
  readonly patch: string;
  readonly targetFile: string;
}

// Mirrors apps/demo/src/lib/price.ts + scripts/plant-bug.ts. We deliberately
// repeat the strings rather than import so the agent stays standalone.
const HEALTHY_LINE =
  "const line = (item: CartItem) => item.price * item.qty;";
const PLANTED_LINE =
  "const line = (item: CartItem) => item.meta.price * item.qty;";

export async function patch(input: PatchInput): Promise<PatchResult> {
  const { incidentId, emit, workspace, targetFile } = input;

  if (targetFile.trim() === "") {
    throw new Error("patch: targetFile is empty");
  }

  const filePath = normalizePath(targetFile);

  emit(
    log(incidentId, "patch.started", "info", {
      targetFile: filePath,
      mode: input.isDemo ? "demo" : "prod",
    }),
  );

  const original = await traceTool(
    emit,
    incidentId,
    "state",
    "readFile",
    { path: filePath },
    async () => {
      const content = await workspace.readFile(filePath);
      if (content === null) {
        throw new Error(`readFile: file not found: ${filePath}`);
      }
      return { path: filePath, size: content.length };
    },
  );

  const content = await workspace.readFile(filePath);
  if (content === null) {
    throw new Error(`patch: file not found: ${filePath}`);
  }

  const next = applyDemoEdit(content);

  if (next === null) {
    throw new Error(
      `patch: no known bug pattern found in ${filePath}; refusing to write blind`,
    );
  }

  await traceTool(
    emit,
    incidentId,
    "state",
    "writeFile",
    { path: filePath, bytes: next.length },
    async () => {
      await workspace.writeFile(filePath, next);
      return { path: filePath, written: next.length };
    },
  );

  const patchText = buildUnifiedDiff(filePath, content, next);

  const diffMsg: DiffMsg = {
    files: [filePath],
    incidentId,
    patch: patchText,
    ts: new Date().toISOString(),
    type: "diff",
  };
  emit(diffMsg);

  emit(
    log(incidentId, "patch.applied", "info", {
      targetFile: filePath,
      added: countLines(patchText, "+"),
      removed: countLines(patchText, "-"),
    }),
  );

  // Tiny trace so `original` isn't flagged as unused — it's the readFile
  // tool_call record; keep it for the dashboard.
  void original;

  return { patch: patchText, targetFile: filePath };
}

function applyDemoEdit(content: string): string | null {
  if (content.includes(PLANTED_LINE)) {
    return content.replace(PLANTED_LINE, HEALTHY_LINE);
  }

  if (content.includes(HEALTHY_LINE)) {
    // File is already healthy. For the demo we still want a visible diff,
    // so synthesize a defensive null-guard next to the healthy line. This
    // produces a plausible "fix" the dashboard can display even when the
    // planted bug hasn't been applied to remote yet.
    const guarded = content.replace(
      HEALTHY_LINE,
      `const line = (item: CartItem) => (item?.price ?? 0) * (item?.qty ?? 0);`,
    );
    return guarded === content ? null : guarded;
  }

  return null;
}

function normalizePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `/${path}`;
}

function buildUnifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  // Tiny unified diff generator — enough for one-file display in the
  // dashboard. Groups contiguous changes into hunks with 3 lines of
  // context on each side.
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  const hunks = diffHunks(beforeLines, afterLines, 3);

  if (hunks.length === 0) {
    return `--- a/${path}\n+++ b/${path}\n`;
  }

  const body = hunks
    .map((h) => {
      const header = `@@ -${h.beforeStart},${h.beforeCount} +${h.afterStart},${h.afterCount} @@`;
      return [header, ...h.lines].join("\n");
    })
    .join("\n");

  return `--- a/${path}\n+++ b/${path}\n${body}\n`;
}

interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

function diffHunks(
  before: readonly string[],
  after: readonly string[],
  context: number,
): Hunk[] {
  // This is not a full LCS diff — it handles single-line substitutions plus
  // simple inserts/deletes aligned to the same line range. For the demo
  // swap (one line edit) this produces a correct unified diff. For more
  // complex edits it still produces a valid diff via a naive line-by-line
  // walk that marks mismatched lines as delete+add.
  const hunks: Hunk[] = [];
  const max = Math.max(before.length, after.length);
  const changedLines: number[] = [];

  for (let i = 0; i < max; i = i + 1) {
    if (before[i] !== after[i]) {
      changedLines.push(i);
    }
  }

  if (changedLines.length === 0) {
    return hunks;
  }

  // Group contiguous (within 2*context distance) change indices into one hunk.
  const groups: number[][] = [];
  let current: number[] = [];

  for (const i of changedLines) {
    if (current.length === 0) {
      current.push(i);
      continue;
    }

    const last = current[current.length - 1]!;
    if (i - last <= context * 2) {
      current.push(i);
      continue;
    }

    groups.push(current);
    current = [i];
  }

  if (current.length > 0) {
    groups.push(current);
  }

  for (const group of groups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const startBefore = Math.max(0, first - context);
    const endBefore = Math.min(before.length, last + context + 1);
    const startAfter = Math.max(0, first - context);
    const endAfter = Math.min(after.length, last + context + 1);

    const lines: string[] = [];

    for (let i = startBefore; i < endBefore; i = i + 1) {
      const b = before[i];
      const a = after[i];

      if (b === a) {
        lines.push(` ${b ?? ""}`);
        continue;
      }

      if (b !== undefined) {
        lines.push(`-${b}`);
      }

      if (a !== undefined) {
        lines.push(`+${a}`);
      }
    }

    // Any tail in `after` beyond `before`'s window (for pure inserts).
    if (endAfter > endBefore) {
      for (let i = endBefore; i < endAfter; i = i + 1) {
        const a = after[i];
        if (a !== undefined) {
          lines.push(`+${a}`);
        }
      }
    }

    hunks.push({
      afterCount: endAfter - startAfter,
      afterStart: startAfter + 1,
      beforeCount: endBefore - startBefore,
      beforeStart: startBefore + 1,
      lines,
    });
  }

  return hunks;
}

function countLines(patch: string, prefix: "+" | "-"): number {
  let count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) {
      count = count + 1;
    }
  }
  return count;
}

function log(
  incidentId: string,
  event: string,
  level: LogMsg["level"],
  fields: Record<string, unknown>,
): LogMsg {
  return {
    event,
    fields,
    incidentId,
    level,
    ts: new Date().toISOString(),
    type: "log",
  };
}
