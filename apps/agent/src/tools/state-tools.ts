/**
 * Thin re-export of `stateTools` from `@cloudflare/shell/workers`.
 *
 * State tools give the sandboxed agent full FS access (readFile, writeFile,
 * glob, searchFiles, planEdits, applyEditPlan, diff, etc.) against the
 * workspace DO's SQLite-backed FS. We expose a single factory so the state
 * machine doesn't reach into the shell package directly.
 */

import { stateTools as shellStateTools } from "@cloudflare/shell/workers";
import type { Workspace } from "@cloudflare/shell";
import type { ToolProvider } from "@cloudflare/codemode";

export function stateTools(workspace: Workspace): ToolProvider {
  return shellStateTools(workspace);
}
