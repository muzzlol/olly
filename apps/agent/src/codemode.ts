/**
 * Codemode executor factory.
 *
 * `createExecutor(env, workspace)` returns a `DynamicWorkerExecutor` bound
 * to the agent's `WorkerLoader` binding. HYPOTHESIZE will hand this
 * executor a ResolvedProvider[] built from `stateTools` + `gitTools` +
 * `clickhouseTools` so the LLM can call all three namespaces inside the
 * sandbox. For the scaffold we only export the factory — no invocation yet.
 */

import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";
import type { Env } from "./worker";

export interface ExecutorOptions {
  readonly sandboxTimeoutMs?: number;
  readonly modelTimeoutMs?: number;
}

export function createExecutor(
  env: Env,
  _workspace: Workspace,
  options: ExecutorOptions = {},
): DynamicWorkerExecutor {
  return new DynamicWorkerExecutor({
    globalOutbound: null,
    loader: env.LOADER,
    timeout: options.sandboxTimeoutMs ?? 30_000,
  });
}
