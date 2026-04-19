#!/usr/bin/env bun
import { createLogger } from "../lib/log.ts";

interface Options {
  readonly help: boolean;
  readonly url: string;
  readonly reason: string;
}

const log = createLogger("reset-incident");
const opts = parseArgs(Bun.argv.slice(2));

if (opts.help) {
  writeUsage();
  process.exit(0);
}

const baseUrl = opts.url || process.env.AGENT_URL;
const secret = process.env.DASHBOARD_WS_SHARED_SECRET;

if (!baseUrl || !secret) {
  log.error("incident.reset_missing_env", {
    hasUrl: Boolean(baseUrl),
    hasSecret: Boolean(secret),
  });
  process.exit(1);
}

const url = new URL("/internal/reset-incident", baseUrl);

log.info("incident.reset_start", {
  url: url.toString(),
  reason: opts.reason,
});

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-dashboard-shared-secret": secret,
  },
  body: JSON.stringify({ reason: opts.reason }),
});

if (!response.ok) {
  const body = await response.text();
  log.error("incident.reset_failed", {
    status: response.status,
    body,
  });
  process.exit(1);
}

const payload = (await response.json()) as {
  readonly ok: boolean;
  readonly state: string;
};

log.info("incident.reset_done", {
  state: payload.state,
  ok: payload.ok,
});

function parseArgs(argv: string[]): Options {
  let help = false;
  let url: string | null = null;
  let reason: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--url") {
      url = readValue(argv, i, arg);
      i += 1;
      continue;
    }

    if (arg === "--reason") {
      reason = readValue(argv, i, arg);
      i += 1;
      continue;
    }

    failUsage(`unknown argument: ${arg}`);
  }

  return {
    help,
    url: url ?? "",
    reason: reason ?? "manual_reset",
  };
}

function readValue(argv: string[], index: number, flag: string): string {
  if (index + 1 < argv.length) {
    return argv[index + 1] ?? "";
  }

  failUsage(`missing value for ${flag}`);
}

function writeUsage(): void {
  process.stdout.write(
    [
      "Usage: bun --env-file=.env run scripts/reset-incident.ts [options]",
      "",
      "Resets current workspace Durable Object to IDLE through agent worker.",
      "Current implementation clears in-memory state only.",
      "",
      "Options:",
      "  --url <agent-url>     Agent worker base URL (default: AGENT_URL env)",
      "  --reason <text>       Audit string sent with reset (default: manual_reset)",
      "  -h, --help            Show this help text",
      "",
      "Required env:",
      "  DASHBOARD_WS_SHARED_SECRET",
      "",
      "Example:",
      "  AGENT_URL=https://olly-olly-agent.example.workers.dev bun --env-file=.env run scripts/reset-incident.ts --reason rerun_demo",
      "",
    ].join("\n"),
  );
}

function failUsage(message: string): never {
  log.error("script.invalid_args", { message });
  writeUsage();
  process.exit(1);
}
