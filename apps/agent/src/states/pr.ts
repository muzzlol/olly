/**
 * PR — branch, commit, push, open GitHub PR via Octokit.
 *
 * Token is auto-injected into push by `createWorkspaceGit`. The PR title/body
 * quote the hypothesis + a preview of the diff so the dashboard can render a
 * complete "review packet" without a second round trip.
 *
 * Demo fallback: when push or PR creation fails (most likely locally, since
 * workerd can't always reach github.com through the sandbox), we emit a
 * synthetic `pr_url` so the dashboard still renders a PR card.
 */

import { Octokit } from "@octokit/rest";
import type { Workspace } from "@cloudflare/shell";
import { createWorkspaceGit } from "../tools/git-tools";
import { traceTool, type Emit } from "../tools/trace";
import type { LogMsg, PrUrlMsg } from "../../../../lib/ws-events.ts";

export interface PrInput {
  readonly incidentId: string;
  readonly emit: Emit;
  readonly workspace: Workspace;
  readonly githubToken: string;
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly targetFile: string;
  readonly errorClass: string;
  readonly hypothesis: string;
  readonly patch: string;
  readonly signature: string;
  readonly deployId: string;
  readonly isDemo: boolean;
}

export interface PrResult {
  readonly url: string;
  readonly number: number;
  readonly usedFallback: boolean;
  readonly fallbackReason?: string;
}

const COMMIT_AUTHOR = {
  email: "agent@olly.dev",
  name: "Olly Agent",
};

export async function openPr(input: PrInput): Promise<PrResult> {
  const { incidentId, emit } = input;
  const branch = `olly/fix/${incidentId}`;
  const git = createWorkspaceGit(input.workspace, input.githubToken);

  emit(log(incidentId, "pr.started", "info", { branch, targetFile: input.targetFile }));

  const localError = await doLocalGitFlow(input, git, branch)
    .then(() => null)
    .catch((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );

  if (localError !== null) {
    if (input.isDemo) {
      return syntheticFallback(input, `local_git: ${localError}`);
    }
    throw new Error(`pr local git failed: ${localError}`);
  }

  const created = await createGithubPr(input, branch).catch((err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
  }));

  if ("error" in created) {
    if (input.isDemo) {
      return syntheticFallback(input, `github_api: ${created.error}`);
    }
    throw new Error(`pr github create failed: ${created.error}`);
  }

  const prUrlMsg: PrUrlMsg = {
    incidentId,
    number: created.number,
    ts: new Date().toISOString(),
    type: "pr_url",
    url: created.url,
  };
  emit(prUrlMsg);

  emit(
    log(incidentId, "pr.created", "info", {
      branch,
      number: created.number,
      url: created.url,
    }),
  );

  return { number: created.number, url: created.url, usedFallback: false };
}

async function doLocalGitFlow(
  input: PrInput,
  git: ReturnType<typeof createWorkspaceGit>,
  branch: string,
): Promise<void> {
  const { emit, incidentId } = input;

  await traceTool(
    emit,
    incidentId,
    "git",
    "checkout",
    { branch, create: true },
    () => git.checkout({ branch, force: true }),
  );

  await traceTool(
    emit,
    incidentId,
    "state",
    "stage",
    { filepath: "." },
    () => git.add({ filepath: "." }),
  );

  await traceTool(
    emit,
    incidentId,
    "git",
    "commit",
    { message: buildCommitMessage(input) },
    () =>
      git.commit({
        author: COMMIT_AUTHOR,
        message: buildCommitMessage(input),
      }),
  );

  await traceTool(
    emit,
    incidentId,
    "git",
    "push",
    { remote: "origin", ref: branch },
    () => git.push({ ref: branch, remote: "origin" }),
  );
}

async function createGithubPr(
  input: PrInput,
  branch: string,
): Promise<{ url: string; number: number }> {
  const octokit = new Octokit({ auth: input.githubToken });

  const result = await traceTool(
    input.emit,
    input.incidentId,
    "git",
    "github.pulls.create",
    {
      base: input.baseBranch,
      head: branch,
      owner: input.owner,
      repo: input.repo,
      title: buildPrTitle(input),
    },
    () =>
      octokit.pulls.create({
        base: input.baseBranch,
        body: buildPrBody(input),
        head: branch,
        owner: input.owner,
        repo: input.repo,
        title: buildPrTitle(input),
      }),
  );

  return {
    number: result.data.number,
    url: result.data.html_url,
  };
}

function syntheticFallback(input: PrInput, reason: string): PrResult {
  const number = 0;
  const url = `https://github.com/${input.owner}/${input.repo}/pull/demo-${input.incidentId.slice(0, 8)}`;

  input.emit(
    log(input.incidentId, "pr.demo_fallback", "warn", {
      reason,
      syntheticUrl: url,
    }),
  );

  const prUrlMsg: PrUrlMsg = {
    incidentId: input.incidentId,
    number,
    ts: new Date().toISOString(),
    type: "pr_url",
    url,
  };
  input.emit(prUrlMsg);

  return { fallbackReason: reason, number, url, usedFallback: true };
}

function buildCommitMessage(input: PrInput): string {
  return [
    `fix: resolve ${input.errorClass} in ${input.targetFile}`,
    "",
    "Signed-off-by Olly agent",
    `Incident: ${input.incidentId}`,
  ].join("\n");
}

function buildPrTitle(input: PrInput): string {
  return `fix: [olly] ${input.errorClass} in ${input.targetFile}`;
}

function buildPrBody(input: PrInput): string {
  const diffPreview = input.patch
    .split("\n")
    .slice(0, 40)
    .join("\n");

  return [
    "### Hypothesis",
    "",
    input.hypothesis || "(none recorded)",
    "",
    "### Diff preview",
    "",
    "```diff",
    diffPreview,
    "```",
    "",
    "### Incident metadata",
    "",
    `- signature: \`${input.signature}\``,
    `- deploy_id: \`${input.deployId || "unknown"}\``,
    `- target_file: \`${input.targetFile}\``,
    "",
    `Auto-generated by Olly from incident ${input.incidentId}.`,
  ].join("\n");
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
