# Olly — MVP spec

## Gist

Olly is an agent platform that watches production logs, decides when something is really broken, investigates, and ships a fix as a PR — all without paging a human. For the hackathon MVP we demo one end-to-end loop on a Cloudflare Worker demo app: a button triggers a "bad deploy", the agent detects the incident, investigates using log queries and the repo's source, generates a patch, opens a PR, then verifies the fix after merge.

Everything runs on Cloudflare. Logs stream via Tail Workers into ClickHouse Cloud. A single Durable Object per workspace runs the investigation state machine, calling tools (ClickHouse queries, repo access via `@cloudflare/shell`, GitHub PR creation) as it reasons. The dashboard streams the agent's state transitions, tool calls, and token-level reasoning over a WebSocket.

The pitch: "Olly is an always-warm, stateful agent per workspace that investigates and fixes production incidents autonomously. sleep ez when olly is on the job."

## Stack

- **Runtime**: Cloudflare Workers + Durable Objects
- **IaC**: `alchemy.run.ts` (root orchestrates tail/agent/dashboard; `apps/demo/alchemy.run.ts` is independent)
- **Logs store**: ClickHouse Cloud — existing service at `ihguwjq35c.ap-south-1.aws.clickhouse.cloud:8443`
- **Log ingestion**: Cloudflare Tail Workers
- **Agent runtime**: `@cloudflare/shell` + `@cloudflare/codemode` (sandboxed JS exec, virtual FS backed by DO SQLite, git tools with auto-auth)
- **LLM**: OpenCode Zen gateway → Claude Sonnet 4.6
  ```ts
  import { createAnthropic } from "@ai-sdk/anthropic"
  const zen = createAnthropic({
    baseURL: "https://opencode.ai/zen/v1",
    apiKey: process.env.OPENCODE_ZEN_API_KEY,
  })
  const model = zen("claude-sonnet-4-6")
  ```
- **Eval/observability**: Braintrust (traces, model call inspection, prompt iteration)
- **Repo access**: `createGit(new WorkspaceFileSystem(workspace))` — clone on demand in `GATHER` with `depth: 1` and `singleBranch: true` into the DO-backed virtual FS
- **GitHub**: fine-grained PAT for `muzzlol/olly-demo-app` (GitHub App is stubbed in UI only)
- **Frontend (dashboard)**: TanStack Start app (`apps/dashboard`), WebSocket to the agent DO
- **Demo target app**: TanStack Start app at `apps/demo/` (separate git repo `muzzlol/olly-demo-app`), gitignored from the monorepo

## Architecture

```
                 demo worker (planted bug)
                         │ console.log/error
                         ▼
                 tail worker  ──── dumb filter ────► ClickHouse Cloud
                         │                            (logs table)
                         │ signal (on match)
                         ▼
                 Workspace DO ──── state machine ────► OpenCode Zen / Sonnet 4.6 (streaming)
                   │ │  │                                    │
                   │ │  └──► ClickHouse tool calls ◄─────────┘
                   │ └────► shell/git tools (clone, read, diff, commit, push)
                   └──────► GitHub API (open PR)
                         │
                         ▼
                     Dashboard (WebSocket: state, tool calls, tokens, diff, PR link)
```

## Repo layout

```
olly/
  alchemy.run.ts              # root: provisions tail + agent + dashboard + DO + secrets (CH service is pre-existing, referenced)
  package.json                # Bun workspaces root; only { alchemy, @types/bun }
  tsconfig.json
  .env                        # all secrets (see secrets section)
  SPEC.md, AGENTS.md, README.md

  apps/
    tail/                     # tail Worker: log handler -> CH insert + DO RPC
    agent/                    # agent Worker: DO host + WS upgrade; depends on @cloudflare/shell, @cloudflare/codemode, ai, @ai-sdk/anthropic, @clickhouse/client-web, @octokit/rest
    dashboard/                # TanStack Start: live incident viewer, WS client

  apps/demo/                  # NESTED separate git repo -> muzzlol/olly-demo-app
                              # has its own alchemy.run.ts, deployed independently
                              # declares tail_consumers: [{ service: "olly-tail" }]
                              # gitignored from root

  scripts/
    bootstrap-ch.ts           # CREATE TABLE IF NOT EXISTS logs + indexes
    query-ch.ts               # manual CH probe
    plant-bug.ts              # commits the planted bug to olly-demo-app via gh api
    reset-bug.ts              # reverts planted commit (resets demo)
    reset-incident.ts         # clears DO state between demo runs
```

## State machine

One workspace DO per workspace. Incidents run sequentially inside it (single-tier). States:

1. `TRIAGE` — dedupe against recent incidents in ClickHouse, check error rate, LLM decides real vs noise.
2. `GATHER` — pull recent logs, recent deploys, clone repo via shell/git into the workspace FS.
3. `HYPOTHESIZE` — agent runs in codemode sandbox with state + git + ClickHouse tools; reasons freely, calls whatever it needs, produces a root-cause hypothesis.
4. `PATCH` — agent edits files in the workspace FS, produces a diff.
5. `PR` — branch, commit, push, open PR via GitHub API; post PR link to dashboard.
6. `MONITOR` — DO alarm sleeps for 10min (30s in demo mode), wakes, queries ClickHouse for same error signature, marks incident resolved or escalated.

## Agent tool surface

The agent runs inside `DynamicWorkerExecutor` from `@cloudflare/codemode`. It gets three tool providers:

- `stateTools(workspace)` — full FS ops (readFile, writeFile, glob, searchFiles, replaceInFiles, planEdits, applyEditPlan, diff, etc.) from `@cloudflare/shell/workers`
- `gitTools(workspace, { token })` — clone, status, add, commit, push, branch, checkout, diff, log (auth auto-injected; LLM never sees the token) from `@cloudflare/shell/git`
- Custom `clickhouseTools` provider exposing: `get_error_rate(signature, window)`, `get_recent_deploys()`, `get_errors_for_user(id)`, `get_recent_errors(limit, window)`, `get_error_context(trace_id)`, `run_sql(query)` — last one is arbitrary read-only SQL for flexibility; the named ones are for legibility on the dashboard

## ClickHouse schema

Single wide table, no joins. ORDER BY `(workspace, timestamp)`, 7-day TTL.

```sql
CREATE TABLE IF NOT EXISTS logs (
  timestamp DateTime64(3),
  workspace String,
  service String,
  level LowCardinality(String),
  message String,
  stack_trace String,
  status_code UInt16,
  route String,
  deploy_id String,
  trace_id String,
  user_id String,
  attrs Map(String, String)
) ENGINE = MergeTree
ORDER BY (workspace, timestamp)
TTL timestamp + INTERVAL 7 DAY;
```

## Dashboard

Split view:

- **Left**: SVG state machine (TRIAGE → GATHER → HYPOTHESIZE → PATCH → PR → MONITOR) with the active state animating.
- **Right**: live stream of tool calls (expandable blocks), LLM tokens, final diff with syntax highlighting, PR link button.

One WebSocket from the browser to the workspace DO (via a WS upgrade endpoint on the agent worker, using DO hibernation API). DO pushes every event: state transitions, tool invocations, tool results, LLM token chunks, final artifacts.

## Demo target

Cloudflare Worker (TanStack Start) deployed from `apps/demo/`. Its homepage has a health dot:

- **Green** when the demo worker's in-memory 5xx counter over the last 30s is below a threshold.
- **Red** when above.

Counter lives in-memory in the worker instance — accuracy isn't the point, visual feedback is. "Deploy bad version" button commits a bad patch to `muzzlol/olly-demo-app:main` via GitHub API (direct commit, single branch). That commit triggers a redeploy. Endpoint starts throwing. Homepage goes red. Agent picks it up. Agent's PR fixes it. Merge. MONITOR verifies. Homepage goes green.

## Ingestion flow

1. Demo Worker emits logs normally (`console.log`/`console.error`).
2. Tail Worker (`olly-tail`) is declared as a consumer in `apps/demo/alchemy.run.ts`; receives every log event.
3. For each event: always insert into ClickHouse (batched every 1s). If it matches the dumb filter (`level in (error, fatal)` OR `status >= 500` OR stack trace present), RPC a signal to the workspace DO.
4. Workspace DO either joins the signal to an existing incident (dedupe) or kicks off `TRIAGE`.

## Secrets (`.env`, loaded via `alchemy.secret()`)

- `ALCHEMY_PASSWORD`
- `OPENCODE_ZEN_API_KEY`
- `CLICKHOUSE_HTTPS_URL` (full `https://host:port`)
- `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE`
- `CLICKHOUSE_ORG_NAME`, `CLICKHOUSE_API_KEY_ID`, `CLICKHOUSE_API_KEY_SECRET` (control plane — for provisioning/admin scripts only)
- `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT` (derived from HTTPS URL, used by scripts)
- `GITHUB_PAT` (fine-grained: contents:write, pull_requests:write, metadata:read on `muzzlol/olly-demo-app`)
- `GITHUB_REPO_OWNER=muzzlol`, `GITHUB_REPO_NAME=olly-demo-app`, `GITHUB_REPO_DEFAULT_BRANCH=main`
- `BRAINTRUST_API_KEY`
- `DASHBOARD_WS_SHARED_SECRET`
- `DEMO_MODE=1`

## Invariants

Each line is a constraint we've committed to. If one breaks, something upstream has to be rethought.

- **stack**
  - Cloudflare Workers + Durable Objects is the entire runtime
  - `alchemy.run.ts` is the only infra config; no `wrangler.toml`
  - ClickHouse Cloud is the only logs store
  - Claude Sonnet 4.6 via OpenCode Zen is the only LLM; streaming mandatory; `@ai-sdk/anthropic` with `baseURL: https://opencode.ai/zen/v1` and `OPENCODE_ZEN_API_KEY`
  - Braintrust wraps all model calls for tracing + replay
- **architecture**
  - one workspace DO per workspace; incidents are serialized inside it (single-tier)
  - state machine has exactly six states: TRIAGE → GATHER → HYPOTHESIZE → PATCH → PR → MONITOR
  - DO alarms drive MONITOR (no polling)
  - WebSocket from dashboard to DO uses hibernation API
  - agent DO requires `WorkerLoader` binding (for `@cloudflare/codemode` `DynamicWorkerExecutor`) and `sqlite: true` (for `Workspace`)
- **ingestion**
  - Tail Worker (`olly-tail`) is the only log source for MVP
  - every log event is inserted into ClickHouse regardless of severity
  - dumb filter (regex/level/status) is the only gate for waking the DO; no classifier model
- **agent**
  - agent runs inside `@cloudflare/codemode` `DynamicWorkerExecutor`
  - agent has three tool providers: `stateTools`, `gitTools`, `clickhouseTools`
  - agent writes arbitrary read-only SQL via `run_sql` AND has named query tools for legibility
  - agent context is shaped only by tool calls — no hand-curated context-window construction
  - GitHub auth is auto-injected by `gitTools`; token never appears in LLM context
- **fix scope**
  - agent only attempts fixes where a stack trace maps to a file in the user's repo
  - fix action is always "open PR" for MVP — no rollback, no flag flip, no restart
  - errors without a mappable stack trace are shown in the dashboard as "detected but out of scope"
- **demo**
  - one planted bug, triggered by a button in the dashboard UI that commits to `muzzlol/olly-demo-app:main` via GitHub API
  - reset via `scripts/reset-bug.ts` — reproducible end to end
  - demo worker reflects health with an in-memory 5xx rate counter on its homepage
  - dashboard is the primary demo surface
  - demo mode: shortened timers (30s MONITOR), `HYPOTHESIZE` capped at 8 turns / 60s wall time, shorter sandbox/model timeouts, deterministic fallback path, no second live model provider
- **repo**
  - `apps/demo` is a separate git repo (`muzzlol/olly-demo-app`), gitignored, independently deployed via its own `alchemy.run.ts`
  - `apps/tail`, `apps/agent`, `apps/dashboard` are Bun workspaces under root `alchemy.run.ts`
  - root `package.json` only carries `alchemy` + types; app-specific deps live in each app

## Dependency graph (what depends on what)

- Tail Worker → requires demo Worker's alchemy config to declare `tail_consumers: [{ service: "olly-tail" }]`
- ClickHouse schema → required before Tail Worker can insert (run `scripts/bootstrap-ch.ts` once)
- Workspace DO → requires ClickHouse (for TRIAGE queries), `@cloudflare/shell` `Workspace` (SQLite-backed FS), `WorkerLoader` binding (for codemode executor)
- Agent tool providers (`clickhouseTools`) → require ClickHouse schema frozen
- Git clone in GATHER → requires GitHub PAT bound to agent worker + `gitTools` wired
- PATCH state → requires GATHER succeeded (repo is in workspace FS)
- PR state → requires PATCH succeeded + GitHub PAT with PR write access
- MONITOR state → requires ingestion working end-to-end
- Dashboard WebSocket stream → requires DO event bus plumbed through every state
- Demo mode flag → cross-cutting; every external call must honour it
- Braintrust tracing → wraps the model client; every LLM call flows through it

## Bootstrap order

1. Clean root (remove leftover `index.ts`, `src/worker.ts`, old template files).
2. Root `package.json` → Bun workspaces: `["apps/tail", "apps/agent", "apps/dashboard"]`.
3. Scaffold `apps/tail`, `apps/agent`, `apps/dashboard` skeletons.
4. Root `alchemy.run.ts`: provisions agent+tail+dashboard workers, DO namespace, `WorkerLoader` binding, all secret bindings, CH env bindings (referencing the existing CH service).
5. `bun run alchemy deploy` → all URLs up.
6. `scripts/bootstrap-ch.ts` → creates `logs` table on the existing CH service.
7. Add `tail_consumers` to `apps/demo/alchemy.run.ts`, redeploy demo.
8. Smoke test: hit demo → log lands in ClickHouse.
9. Dashboard opens WS to agent worker, receives a ping → plumbing verified.
10. `scripts/plant-bug.ts` seeds the bad commit; demo 5xx rate rises; tail RPCs the DO.
11. Now write the state machine.

## Frozen defaults

- `deploy_id` uses `TraceItem.scriptVersion.id` as the canonical value for logs and `get_recent_deploys()`. Use `scriptVersion.tag` only when `id` is missing in local/dev traces.
- Incident signatures for `TRIAGE` and `MONITOR` use `service + normalized top-of-stack frame + error class`. When no stack exists, fall back to `service + route + status + normalized message prefix`.
- Repo clone happens in `GATHER` via `git.clone({ depth: 1, singleBranch: true, branch: defaultBranch })`. Do not pre-warm the repo on DO init.
- `HYPOTHESIZE` stops after 8 turns or 60s wall time, whichever comes first. Demo mode keeps the same Zen/Sonnet provider and falls back to the deterministic demo patch path instead of a second model provider.

## Still open / deferred

- **Two-tier DO refactor**: deferred; revisit only if single-tier hits a wall.
- **GitHub App stub**: visual-only "Install" button in dashboard — modal or fake redirect?
