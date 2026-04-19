/**
 * HYPOTHESIZE — free-form reasoning inside the codemode sandbox, capped
 * at `turnCap` model turns or `wallMs` wall-time, whichever comes first.
 *
 * The agent is handed three tool providers:
 *   - `state.*`  — FS ops against the cloned workspace (read-only here).
 *   - `git.*`    — log/diff/status (no writes in HYPOTHESIZE).
 *   - `clickhouse.*` — named queries + read-only `run_sql`.
 *
 * It streams tokens to the dashboard and returns `{ hypothesis, targetFile }`.
 *
 * Demo-mode fallback: any failure (no API key, network, timeout, refusal)
 * flips to a deterministic hypothesis so the rest of the loop can run.
 */

import { generateText, stepCountIs, streamText, tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { ToolProvider, Executor } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";
import { gitTools } from "../tools/git-tools";
import { stateTools } from "../tools/state-tools";
import type { ClickHouseTools } from "../tools/clickhouse-tools";
import type { Emit } from "../tools/trace";
import type { LogMsg, TokenMsg } from "../../../../lib/ws-events.ts";

export interface HypothesizeInput {
  readonly incidentId: string;
  readonly emit: Emit;
  readonly executor: Executor;
  readonly model: LanguageModel;
  readonly workspace: Workspace;
  readonly clickhouse: ClickHouseTools;
  readonly githubToken: string;
  readonly context: HypothesizeContext;
  readonly isDemo: boolean;
  readonly turnCap: number;
  readonly wallMs: number;
  readonly modelTimeoutMs: number;
}

export interface HypothesizeContext {
  readonly signature: string;
  readonly service: string;
  readonly errorClass: string;
  readonly message: string;
  readonly stackFrame: string;
  readonly stackFile: string;
  readonly recentErrorsCount: number;
  readonly recentDeploysCount: number;
}

export interface HypothesizeResult {
  readonly hypothesis: string;
  readonly targetFile: string;
  readonly usedFallback: boolean;
  readonly fallbackReason?: string;
}

const DEMO_HYPOTHESIS =
  "TypeError in computeTotal — missing null-guard on cart items";
const DEMO_TARGET_FILE = "src/lib/price.ts";

const RESULT_SCHEMA = z.object({
  hypothesis: z
    .string()
    .min(1)
    .describe("One or two sentence root-cause hypothesis."),
  target_file: z
    .string()
    .min(1)
    .describe(
      "Path (repo-relative) of the single file that should be patched, e.g. src/lib/price.ts",
    ),
});

export async function hypothesize(
  input: HypothesizeInput,
): Promise<HypothesizeResult> {
  if (input.isDemo && !hasModelKey(input.model)) {
    return demoFallback(input, "no_api_key");
  }

  const result = await runReal(input).catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: reason } as const;
  });

  if ("error" in result) {
    if (input.isDemo) {
      return demoFallback(input, result.error);
    }
    throw new Error(`hypothesize failed: ${result.error}`);
  }

  return result;
}

async function runReal(input: HypothesizeInput): Promise<HypothesizeResult> {
  const emit = input.emit;
  const incidentId = input.incidentId;
  const turnCap = input.turnCap;

  // Tool providers for codemode. Each is a `ToolProvider` (name + tools
  // + optional types/positionalArgs). `createCodeTool` resolves them
  // internally.
  const stateProvider = stateTools(input.workspace);
  const gitProvider = gitTools(input.workspace, input.githubToken);
  const clickhouseProvider = buildClickhouseProvider(input.clickhouse);

  const codemode = createCodeTool({
    executor: input.executor,
    tools: [stateProvider, gitProvider, clickhouseProvider],
  });

  const tools: ToolSet = { codemode };

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input.context);

  emit(
    log(incidentId, "hypothesize.started", "info", {
      turnCap,
      wallMs: input.wallMs,
    }),
  );

  const stream = streamText({
    model: input.model,
    system: systemPrompt,
    prompt: userPrompt,
    tools,
    stopWhen: stepCountIs(turnCap),
    abortSignal: AbortSignal.timeout(input.modelTimeoutMs),
  });

  // Stream tokens out. `turn` tracks text-deltas per step.
  let turn = 0;
  for await (const part of stream.fullStream) {
    if (part.type === "text-delta") {
      const tokenMsg: TokenMsg = {
        chunk: part.text,
        incidentId,
        ts: new Date().toISOString(),
        turn,
        type: "token",
      };
      emit(tokenMsg);
      continue;
    }

    if (part.type === "finish-step") {
      turn = turn + 1;
      continue;
    }

    if (part.type === "error") {
      throw part.error instanceof Error
        ? part.error
        : new Error(String(part.error));
    }
  }

  const finalText = await stream.text;

  emit(
    log(incidentId, "hypothesize.stream_complete", "info", {
      turns: turn,
      chars: finalText.length,
    }),
  );

  // Ask the model to structure its own reasoning into a deterministic shape.
  // We do NOT stream this call — it's a cheap one-shot parser.
  const structured = await generateText({
    model: input.model,
    system:
      "You are an extractor. Return ONLY a JSON object matching the schema. No prose.",
    prompt: [
      "Extract the root-cause hypothesis and the single repo-relative target file path from the following investigation transcript.",
      "If no mappable path is mentioned, return an empty string for target_file.",
      "",
      "Transcript:",
      finalText,
    ].join("\n"),
    abortSignal: AbortSignal.timeout(input.modelTimeoutMs),
  });

  const parsed = safeParseJsonObject(structured.text);
  const validated = parsed ? RESULT_SCHEMA.safeParse(parsed) : null;

  // Recovery path: when the model produced tool calls but no final text (or
  // the extractor couldn't parse it), synthesize a hypothesis from the
  // context we already have. The stack file is known-good — TRIAGE verified
  // it's mappable to user code. Better to patch than escalate.
  if (!validated || !validated.success) {
    const fallbackHypothesis =
      finalText.trim().length > 0
        ? finalText.trim().split("\n").slice(0, 4).join(" ").slice(0, 400)
        : `${input.context.errorClass} in ${input.context.stackFile}`;
    const fallbackTarget = input.context.stackFile;

    emit(
      log(incidentId, "hypothesize.extract_recovered", "warn", {
        reason: validated
          ? `schema_mismatch: ${validated.error.message}`
          : "json_parse_failed",
        transcriptChars: finalText.length,
        fallbackTarget,
      }),
    );

    emit(
      log(incidentId, "hypothesize.result", "info", {
        hypothesis: fallbackHypothesis,
        targetFile: fallbackTarget,
        source: "stream_recovery",
      }),
    );

    return {
      hypothesis: fallbackHypothesis,
      targetFile: fallbackTarget,
      usedFallback: false,
    };
  }

  const hypothesis = validated.data.hypothesis.trim();
  const targetFile = normalizeTargetFile(validated.data.target_file);

  if (targetFile === "") {
    // Same recovery: fall back to stack file.
    emit(
      log(incidentId, "hypothesize.empty_target_recovered", "warn", {
        hypothesis,
        fallbackTarget: input.context.stackFile,
      }),
    );
    return {
      hypothesis,
      targetFile: input.context.stackFile,
      usedFallback: false,
    };
  }

  emit(
    log(incidentId, "hypothesize.result", "info", {
      hypothesis,
      targetFile,
    }),
  );

  return { hypothesis, targetFile, usedFallback: false };
}

function demoFallback(
  input: HypothesizeInput,
  reason: string,
): HypothesizeResult {
  input.emit(
    log(input.incidentId, "hypothesize.demo_fallback", "warn", { reason }),
  );
  input.emit(
    log(input.incidentId, "hypothesize.result", "info", {
      hypothesis: DEMO_HYPOTHESIS,
      targetFile: DEMO_TARGET_FILE,
      source: "demo_fallback",
    }),
  );
  return {
    fallbackReason: reason,
    hypothesis: DEMO_HYPOTHESIS,
    targetFile: DEMO_TARGET_FILE,
    usedFallback: true,
  };
}

function buildSystemPrompt(): string {
  return [
    "You are Olly, an autonomous incident investigator for a Cloudflare Workers app.",
    "You have one codemode sandbox tool with three tool providers accessible inside it:",
    "  state.*       — read/search files in the cloned repo (readFile, glob, searchFiles, etc.).",
    "  git.*         — read-only history (log, status, diff).",
    "  clickhouse.*  — named queries (getErrorRate, getRecentErrors, getRecentDeploys, getErrorsForUser, getErrorContext) and run_sql(query) for arbitrary read-only SQL against the logs table.",
    "",
    "Goal: produce a concise root-cause hypothesis for the incident and identify the single file to patch.",
    "",
    "Strategy:",
    "1. Read the top-of-stack file to understand the failing code.",
    "2. Use clickhouse.getRecentErrors or run_sql for extra context if useful.",
    "3. Inspect git log briefly for recent suspicious edits.",
    "4. Finish with a short, direct answer stating the hypothesis AND the exact repo-relative target file path (e.g. src/lib/price.ts).",
    "",
    "Budget: you have very little time. Keep calls minimal and focused. Do NOT write files. Do NOT branch or commit.",
  ].join("\n");
}

function buildUserPrompt(ctx: HypothesizeContext): string {
  return [
    "Incident signal:",
    `  signature:        ${ctx.signature}`,
    `  service:          ${ctx.service}`,
    `  error class:      ${ctx.errorClass}`,
    `  message:          ${ctx.message}`,
    `  top stack frame:  ${ctx.stackFrame}`,
    `  top stack file:   ${ctx.stackFile}`,
    `  recent errors (15min): ${ctx.recentErrorsCount}`,
    `  recent deploys:   ${ctx.recentDeploysCount}`,
    "",
    "Task:",
    "  Investigate with the codemode tool, then finish with a one-paragraph conclusion that includes:",
    "    - a concise root-cause hypothesis.",
    "    - the single repo-relative target file path to patch (e.g. src/lib/price.ts).",
  ].join("\n");
}

function buildClickhouseProvider(ch: ClickHouseTools): ToolProvider {
  // Expose the named queries as AI-SDK `tool()` objects. `createCodeTool`
  // will lift execute + inputSchema into the sandbox under `clickhouse.*`.
  const tools: ToolSet = {
    getErrorRate: tool({
      description: "Count of matching errors over the last N seconds.",
      inputSchema: z.object({
        signature: z.string(),
        windowSec: z.number().int().positive(),
      }),
      execute: ({ signature, windowSec }) =>
        ch.getErrorRate(signature, windowSec),
    }),
    getRecentErrors: tool({
      description: "Recent error log rows for a service.",
      inputSchema: z.object({
        service: z.string(),
        limit: z.number().int().positive().default(50),
        windowSec: z.number().int().positive().default(900),
      }),
      execute: ({ service, limit, windowSec }) =>
        ch.getRecentErrors(service, limit, windowSec),
    }),
    getRecentDeploys: tool({
      description: "Recent deploy rollouts for a service.",
      inputSchema: z.object({
        service: z.string(),
        limit: z.number().int().positive().default(10),
      }),
      execute: ({ service, limit }) => ch.getRecentDeploys(service, limit),
    }),
    getErrorsForUser: tool({
      description: "Errors attributed to a specific user id.",
      inputSchema: z.object({
        userId: z.string(),
        limit: z.number().int().positive().default(50),
      }),
      execute: ({ userId, limit }) => ch.getErrorsForUser(userId, limit),
    }),
    getErrorContext: tool({
      description: "All rows associated with a trace id.",
      inputSchema: z.object({ traceId: z.string() }),
      execute: ({ traceId }) => ch.getErrorContext(traceId),
    }),
    run_sql: tool({
      description: "Arbitrary read-only SELECT against the logs table.",
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => ch.runSql(query),
    }),
  };

  return { name: "clickhouse", tools };
}

function hasModelKey(_model: LanguageModel): boolean {
  // We don't have reliable access to the key from the LanguageModel; the DO
  // passes `isDemo` and we inspect env externally. Callers should ensure the
  // key is set before invoking the real path. Keep this permissive: only the
  // demo fallback uses the `no_api_key` shortcut when truly missing.
  return true;
}

function normalizeTargetFile(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed.startsWith("/")) {
    return trimmed.slice(1);
  }
  if (trimmed.startsWith("./")) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function safeParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return null;
  }

  const slice = trimmed.slice(start, end + 1);

  try {
    const value: unknown = JSON.parse(slice);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
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
