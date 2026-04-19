/**
 * Git tools bound to the workspace FS with the GitHub PAT auto-injected.
 *
 * Exposes two shapes:
 *   - `gitTools(workspace, token)` → `ToolProvider` for codemode sandbox use.
 *   - `createWorkspaceGit(workspace, token)` → direct `Git` instance for
 *     the state machine (e.g. GATHER / PR states) so we can trace individual
 *     commands through `traceTool` without going through codemode.
 *
 * The token is never surfaced to the LLM: it's captured in the closure and
 * merged into clone/fetch/pull/push calls inside `createWorkspaceGit`.
 */

import { createGit, gitTools as shellGitTools } from "@cloudflare/shell/git";
import { WorkspaceFileSystem } from "@cloudflare/shell";
import type { Workspace } from "@cloudflare/shell";
import type { Git } from "@cloudflare/shell/git";
import type { ToolProvider } from "@cloudflare/codemode";

export function gitTools(workspace: Workspace, token: string): ToolProvider {
  return shellGitTools(workspace, { token });
}

export function createWorkspaceGit(workspace: Workspace, token: string): Git {
  const fs = new WorkspaceFileSystem(workspace);
  const git = createGit(fs);
  return wrapWithToken(git, token);
}

function wrapWithToken(git: Git, token: string): Git {
  return {
    ...git,
    clone: (opts) => git.clone({ ...opts, token: opts.token ?? token }),
    fetch: (opts) => git.fetch({ ...opts, token: opts?.token ?? token }),
    pull: (opts) => git.pull({ ...opts, token: opts?.token ?? token }),
    push: (opts) => git.push({ ...opts, token: opts?.token ?? token }),
  };
}
