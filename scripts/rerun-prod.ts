#!/usr/bin/env bun
import { createLogger } from "../lib/log.ts";

// End-to-end re-runner for the deployed demo.
//
// Chains:
//   1. demo:reset-bug     (revert src/lib/price.ts on muzzlol/olly-demo-app main)
//                         skipped when the repo is already healthy (idempotent)
//   2. incident:reset     (POST deployed agent /internal/reset-incident -> IDLE)
//   3. demo:plant-bug     (commit the demo bug back to main)
//
// Requires AGENT_URL and DASHBOARD_WS_SHARED_SECRET in .env (same env the
// individual scripts already use). Pass any extra flags through to each step
// with `--plant-arg <value>` / `--reset-arg <value>` pairs if you need them;
// by default every child runs with no extra args.

const DEMO_PATH = "src/lib/price.ts";
const PLANTED_LINE =
  "const line = (item: CartItem) => item.meta.price * item.qty;";

const log = createLogger("rerun-prod");

const argv = Bun.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  writeHelp();
  process.exit(0);
}

const reason = readFlag(argv, "--reason") ?? "rerun_prod";
const dryRun = argv.includes("--dry-run");

assertEnv("AGENT_URL");
assertEnv("DASHBOARD_WS_SHARED_SECRET");
assertEnv("GITHUB_PAT");

const shouldReset = await repoHasPlantedBug();

const steps = [
  ...(shouldReset
    ? [
        {
          name: "reset-bug",
          script: "scripts/reset-bug.ts",
          args: dryRun ? ["--dry-run"] : [],
        },
      ]
    : []),
  {
    name: "incident-reset",
    script: "scripts/reset-incident.ts",
    args: ["--reason", reason],
  },
  {
    name: "plant-bug",
    script: "scripts/plant-bug.ts",
    args: dryRun ? ["--dry-run"] : [],
  },
] as const;

log.info("rerun.start", {
  reason,
  dryRun,
  stepCount: steps.length,
  resetSkipped: !shouldReset,
});

for (const step of steps) {
  log.info("rerun.step_start", { step: step.name });
  const code = await runStep(step.script, step.args);

  if (code !== 0) {
    log.error("rerun.step_failed", { step: step.name, code });
    process.exit(code);
  }

  log.info("rerun.step_done", { step: step.name });
}

log.info("rerun.done", { reason });

// Pre-check: peek at the demo repo file on main so we can skip reset-bug when
// it has nothing to undo. Any non-200 aborts so auth/network failures still
// surface loudly instead of silently skipping.
async function repoHasPlantedBug(): Promise<boolean> {
  const token = process.env.GITHUB_PAT!;
  const owner = process.env.GITHUB_REPO_OWNER ?? "muzzlol";
  const repoName = process.env.GITHUB_REPO_NAME ?? "olly-demo-app";
  const branch = process.env.GITHUB_REPO_DEFAULT_BRANCH ?? "main";

  const url = `https://api.github.com/repos/${owner}/${repoName}/contents/${DEMO_PATH}?ref=${encodeURIComponent(
    branch,
  )}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.raw",
      Authorization: `Bearer ${token}`,
      "User-Agent": "olly-scripts",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    log.error("rerun.precheck_failed", {
      owner,
      repo: repoName,
      branch,
      path: DEMO_PATH,
      status: res.status,
    });
    process.exit(1);
  }

  const contents = await res.text();
  const planted = contents.includes(PLANTED_LINE);

  log.info("rerun.precheck_done", {
    owner,
    repo: repoName,
    branch,
    path: DEMO_PATH,
    planted,
  });

  return planted;
}

async function runStep(script: string, args: readonly string[]): Promise<number> {
  const proc = Bun.spawn({
    cmd: ["bun", "--env-file=.env", "run", script, ...args],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  return await proc.exited;
}

function readFlag(input: readonly string[], flag: string): string | null {
  const index = input.indexOf(flag);
  if (index === -1) return null;
  return input[index + 1] ?? null;
}

function assertEnv(key: string): void {
  if (process.env[key]) return;
  log.error("rerun.missing_env", { key });
  process.exit(1);
}

function writeHelp(): void {
  process.stdout.write(
    [
      "Usage: bun --env-file=.env run scripts/rerun-prod.ts [options]",
      "",
      "Re-runs the deployed demo loop against prod workers:",
      "  1. reset-bug       revert the planted mutation on main",
      "  2. incident:reset  flip the deployed agent DO back to IDLE",
      "  3. plant-bug       commit the demo bug to main",
      "",
      "Options:",
      "  --reason <text>  Audit string for incident:reset (default: rerun_prod)",
      "  --dry-run        Pass --dry-run to plant/reset steps (incident:reset still runs)",
      "  -h, --help       Show this help text",
      "",
      "Required env: AGENT_URL, DASHBOARD_WS_SHARED_SECRET, GITHUB_PAT",
      "",
    ].join("\n"),
  );
}
