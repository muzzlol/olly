#!/usr/bin/env bun
// Reads stdin line-by-line, mirrors to stdout, and fans out JSON log lines
// produced by lib/log.ts into per-service files so parallel agents can tail
// one app without drowning in the others.
//
// Routing (by the `service` field on each JSON line):
//   olly-tail       -> apps/tail/logs/dev.log
//   olly-agent      -> apps/agent/logs/dev.log
//   olly-dashboard  -> apps/dashboard/logs/dev.log
//   everything else -> logs/dev.log (root)
//
// Non-JSON lines (alchemy CLI chatter, stack traces, wrangler output) go to
// the root logs/dev.log so nothing is lost.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const cwd = process.cwd();

const routes: Record<string, string> = {
  "olly-tail": resolve(cwd, "apps/tail/logs/dev.log"),
  "olly-agent": resolve(cwd, "apps/agent/logs/dev.log"),
  "olly-dashboard": resolve(cwd, "apps/dashboard/logs/dev.log"),
};
const fallback = resolve(cwd, "logs/dev.log");

const ensured = new Set<string>();
function ensureDir(path: string) {
  const dir = dirname(path);
  if (ensured.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  ensured.add(dir);
}

function route(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return fallback;
  const parsed = safeParse(trimmed);
  if (!parsed) return fallback;
  const service = typeof parsed.service === "string" ? parsed.service : null;
  if (!service) return fallback;
  return routes[service] ?? fallback;
}

function safeParse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

async function main() {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      process.stdout.write(`${line}\n`);
      const target = route(line);
      ensureDir(target);
      appendFileSync(target, `${line}\n`);
    }
  }

  if (buffer.length > 0) {
    process.stdout.write(buffer);
    const target = route(buffer);
    ensureDir(target);
    appendFileSync(target, buffer);
  }
}

await main();
