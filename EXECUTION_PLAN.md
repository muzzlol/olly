# Execution Plan

Use this as the shared handoff doc.

- Re-read `SPEC.md`, this file, and the touched area of the repo before starting work.
- Update task state inline: `[ ]` not started, `[-]` in progress, `[x]` done, `[!]` blocked.
- Leave a short `Handoff:` line in the phase you touched with files changed, commands run, and blockers.
- Prefer the smallest dependency-complete slice over broad partial edits.

Current state hint: Foundation is complete. Root is a Bun workspace with `apps/tail`, `apps/agent`, `apps/dashboard` all scaffolded and deployed. `apps/demo` is still close to the default TanStack/Alchemy scaffold (separate repo).

Dev loop: `bun run dev` at the root runs `alchemy dev` which brings up tail, agent, and dashboard together via `workerd`, teeing output to `logs/dev.log`. Per-app `dev` scripts are intentionally omitted for tail/agent since they're orchestrated by the root `alchemy.run.ts`; `apps/dashboard` keeps its own `vite dev` for UI iteration.

## Decision Spikes

Outcome: open spec choices are turned into defaults in code or short notes.
Depends on: none.
Parallel: can run beside `Foundation`.

- [x] Confirm how `tail_consumers` is expressed through Alchemy or the Wrangler escape hatch.
  Decision: Alchemy `Worker` accepts `tailConsumers: [workerRef]` natively. No escape hatch needed.
- [x] Freeze the `deploy_id` source used in logs and `get_recent_deploys`.
  Decision: use `TraceItem.scriptVersion.id` as the canonical deploy ID. Fall back to `scriptVersion.tag` only when `id` is missing in local/dev traces.
- [x] Freeze the incident dedupe key before `TRIAGE` lands.
  Decision: use `service + normalized top-of-stack frame + error class`, with fallback to `service + route + status + normalized message prefix` when no stack is available.
- [x] Decide clone strategy: shallow clone on demand or pre-warm on DO init.
  Decision: clone on demand in `GATHER` with `depth: 1` and `singleBranch: true`; do not pre-warm on DO init.
- [x] Decide codemode turn/time caps and whether demo mode keeps a model fallback.
  Decision: cap `HYPOTHESIZE` at `8` turns or `60s` wall time. Demo mode keeps the same Zen/Sonnet model path, uses shorter sandbox/model timeouts, and falls back to the deterministic demo patch path instead of a second model provider.
- Handoff: froze the four stream-A decisions in `SPEC.md` and this file; added `lib/incident.ts` so the tail worker now emits a stable incident `signature`, `signatureSource`, and `errorClass`, and records `deploy_source` alongside the frozen `deploy_id`. Files changed: `SPEC.md`, `EXECUTION_PLAN.md`, `lib/incident.ts`, `apps/tail/src/index.ts`. Commands: `bunx tsc -p apps/tail/tsconfig.json --pretty false`. Blockers: deterministic demo fallback still needs the demo repo's exact bug path once `apps/demo/` is available locally.

## Foundation

Outcome: the repo matches the MVP shape instead of the starter scaffold.
Depends on: none.
Parallel: `Decision Spikes`, early `Demo Target` work, early `Dashboard` shell work.

- [x] Remove leftover starter files and unused template code at the root.
- [x] Convert root `package.json` into a Bun workspace for `apps/tail`, `apps/agent`, and `apps/dashboard`.
- [x] Scaffold the missing app folders with package metadata, TS config, and minimal entrypoints.
- [x] Rewrite root `alchemy.run.ts` to provision tail, agent, dashboard, the workspace DO, `WorkerLoader`, SQLite, and secret/env bindings.
- [x] Add `lib/log.ts` as the shared structured logger and switch current root/tail/agent logs to wide events.
- [x] Add script stubs for ClickHouse bootstrap/query and incident reset flows.
- Handoff: Foundation complete. Resource names: `olly-tail`, `olly-agent`, `olly-dashboard`. DO class: `WorkspaceDO` with `sqlite: true`. Agent bindings: `WORKSPACE` (DO), `LOADER` (WorkerLoader), all CH/GitHub/Zen secrets. Tail bindings: CH credentials. Dashboard bindings: `AGENT_URL`, `DASHBOARD_WS_SHARED_SECRET`. Deploy URLs: `olly-olly-{tail,agent,dashboard}-muzz.muzzz.workers.dev`. Tail worker has no `fetch` handler (1101 expected). `tailConsumers` is a first-class Alchemy Worker prop — no wrangler escape hatch needed. Shared logger: `lib/log.ts`. Root scripts now expose `ch:bootstrap`, `ch:query`, `demo:plant-bug`, `demo:reset-bug`, and `incident:reset`. `plant-bug.ts` / `reset-bug.ts` are generic GitHub contents mutation stubs (`--path`, `--find`, `--replace`, `--message`); `reset-incident.ts` POSTs `/internal/reset-incident` and current DO reset clears in-memory state back to `IDLE`. Files changed: `lib/log.ts`, `alchemy.run.ts`, `apps/tail/src/index.ts`, `apps/agent/src/worker.ts`, `apps/agent/src/workspace-do.ts`, `package.json`, `scripts/lib/github-contents.ts`, `scripts/plant-bug.ts`, `scripts/reset-bug.ts`, `scripts/reset-incident.ts`, `EXECUTION_PLAN.md`. Commands: `bunx tsc -p apps/agent/tsconfig.json --pretty false`, `bunx tsc --noEmit --pretty false --target ESNext --module Preserve --moduleResolution bundler --allowImportingTsExtensions --lib ESNext --types bun --skipLibCheck scripts/lib/github-contents.ts scripts/plant-bug.ts scripts/reset-bug.ts scripts/reset-incident.ts lib/log.ts`, `bun run scripts/plant-bug.ts --help`, `bun run scripts/reset-bug.ts --help`, `bun run scripts/reset-incident.ts --help`. Blockers: demo repo bug path/marker still TBD; reset currently clears in-memory DO state only.

## ClickHouse And Ingestion

Outcome: every log lands in ClickHouse and severe signals wake the workspace DO.
Depends on: `Foundation`, `tail_consumers` decision.
Parallel: `Workspace Runtime`, `Dashboard` shell work, `Demo Target` instrumentation.

- [x] Ship `scripts/bootstrap-ch.ts` against the fixed `logs` schema.
- [x] Ship `scripts/query-ch.ts` for manual CH probes.
- [x] Implement `apps/tail` batching to ClickHouse with the dumb severity filter for DO wakeups.
- [ ] Wire `apps/demo/alchemy.run.ts` to send logs to `olly-tail`.
- [ ] Verify a manual demo request inserts rows before incident logic exists.
- Handoff: files changed: `scripts/bootstrap-ch.ts`, `scripts/query-ch.ts`, `apps/tail/src/index.ts`, `alchemy.run.ts`, `EXECUTION_PLAN.md`. Commands: `bunx tsc -p apps/tail/tsconfig.json --pretty false`, `bunx tsc --noEmit --pretty false --target ESNext --module Preserve --moduleResolution bundler --allowImportingTsExtensions --lib ESNext --types bun --skipLibCheck alchemy.run.ts lib/log.ts`, `bun run dev`. Notes: tail writes one batched insert per tail callback, flattening fetch/request summaries plus log/exception rows into `logs`, and posts severe batches to `olly-agent` `/signal` (`error`/`fatal`, `status >= 500`, or stack trace present). Directly binding the DO into `olly-tail` made dev/runtime try to host `WorkspaceDO` in the tail worker, so signaling now goes through the agent worker instead. Canonical `deploy_id` is `scriptVersion.id`, with `scriptVersion.tag` used only when `id` is missing in local/dev traces. Blockers: `apps/demo/` is not present locally yet, so `tailConsumers` wiring and a manual end-to-end insert check remain pending.

## Workspace Runtime

Outcome: one workspace DO can persist state, host WS clients, run alarms, and execute codemode with tools.
Depends on: `Foundation`; ClickHouse schema should be frozen before final query tool shapes.
Parallel: `ClickHouse And Ingestion`, `Dashboard` shell work, `Demo Target` work.

look at agents/ dir which conatins the source code for the cloudflare agents package to figure out how shit works if need be. 

- [x] Implement the agent worker and workspace DO host with serialized incident execution.
- [x] Back the workspace with DO SQLite and bind `WorkerLoader` for `DynamicWorkerExecutor`.
- [-] Wrap Zen / Sonnet calls with Braintrust tracing and streaming.
- [x] Expose `stateTools`, `gitTools`, and `clickhouseTools` with dashboard-friendly names.
- [x] Add the DO event bus and WS upgrade path, even if early payloads are placeholders.
- Handoff: workspace runtime is scaffolded end-to-end on the frozen contract in `lib/ws-events.ts`. Files changed: `apps/agent/src/worker.ts` (added `GET /internal/state` auth'd by `x-dashboard-shared-secret`), `apps/agent/src/workspace-do.ts` (full rewrite), `apps/agent/src/model.ts` (new — `createZenModel`, `withTracing` no-op), `apps/agent/src/codemode.ts` (new — `createExecutor(env, workspace)`), `apps/agent/src/tools/state-tools.ts` (new — re-exports `stateTools` from `@cloudflare/shell/workers`), `apps/agent/src/tools/git-tools.ts` (new — `gitTools(workspace, token)` + `createWorkspaceGit` with PAT auto-injection), `apps/agent/src/tools/clickhouse-tools.ts` (new — `createClickHouseTools(config)` with named queries + read-only `runSql`), `apps/agent/src/tools/trace.ts` (new — `traceTool(emit, incidentId, provider, tool, args, fn)` emits `tool_call` + `tool_result`). Commands: `bunx tsc -p apps/agent/tsconfig.json --pretty false` (clean). SQLite schema on the DO: `incidents(id TEXT PRIMARY KEY, signature TEXT, state TEXT, started_at INTEGER, resolved_at INTEGER, resolution TEXT, service TEXT, error_class TEXT, message TEXT)` plus indexes `incidents_by_signature(signature, started_at DESC)` and `incidents_open(state) WHERE resolved_at IS NULL`; `events(id INTEGER PK AUTOINCREMENT, incident_id TEXT, type TEXT, payload TEXT, ts INTEGER)` with `events_by_incident(incident_id, id)`. Every `emit()` persists one row and broadcasts to every hibernated WS via `ctx.getWebSockets()`. Incidents run serially: an in-memory `queue` + `running: boolean` guard; signals within 5min that match an open incident's `signature` append (emit a `signal` carrying the existing `incidentId`) instead of queuing. WS events emitted per state: TRIAGE → `state(TRIAGE)` + `tool_call/tool_result(clickhouse.getErrorRate, stub)`; GATHER → `state(GATHER)` + `tool_call/tool_result(git.clone, stub)`; HYPOTHESIZE → `state(HYPOTHESIZE)` + `tool_call/tool_result(state.plan, stub)`; PATCH → `state(PATCH)` + `tool_call/tool_result(state.applyEditPlan, stub)`; PR → `state(PR)` + `tool_call/tool_result(git.push, stub)`; MONITOR → `state(MONITOR)` then later on alarm `tool_call/tool_result(clickhouse.getErrorRate, real)` + `incident_resolved(fixed|escalated)` + `state(IDLE)`. On connect the DO sends `HelloMsg { protocol, state, incidentId?, ts }`. `ping` → `pong`. Reset (`POST /internal/reset-incident`) cancels the alarm, clears the `monitor` key, `DELETE FROM events` and `DELETE FROM incidents`, drops the in-mem queue, resets state to `IDLE`, broadcasts `incident_reset { state: "IDLE" }`. MONITOR window: 10min prod / 30s when `env.DEMO_MODE === "1"`; transition delay between states is 1s prod / 200ms demo. Tool function names: ClickHouse — `getErrorRate(signature, windowSec)`, `getRecentDeploys(service, limit)`, `getErrorsForUser(userId, limit)`, `getRecentErrors(service, limit, windowSec)`, `getErrorContext(traceId)`, `runSql(query)` (rejects on `insert|update|delete|alter|drop|truncate|rename|attach|detach|create|replace|grant|revoke|optimize`); Git — `createWorkspaceGit(workspace, token)` returns the full `@cloudflare/shell/git` `Git` surface (clone/status/add/rm/commit/log/branch/checkout/fetch/pull/push/diff/init/remote) with the PAT auto-merged into clone/fetch/pull/push; State — full `@cloudflare/shell/workers` `stateTools` provider (readFile, writeFile, glob, searchFiles, planEdits, applyEditPlan, diff, etc.). Model: `createZenModel(env)` returns `zen("claude-sonnet-4-6")` via `createAnthropic({ baseURL: "https://opencode.ai/zen/v1", apiKey: env.OPENCODE_ZEN_API_KEY })`. `withTracing(model, name, env)` currently no-ops — Braintrust dep deferred, flagged below. Codemode: `createExecutor(env, workspace)` returns `new DynamicWorkerExecutor({ loader: env.LOADER, globalOutbound: null, timeout: 30000 })`. Blockers: (a) codemode executor not yet invoked in HYPOTHESIZE — state handler is still a stub trace + sleep; (b) git clone / patch / PR states are stubs — `createWorkspaceGit` is wired and token-scoped but not yet called from GATHER/PR; (c) Braintrust not added as a dep — `withTracing` is a no-op for MVP; add `braintrust` to `apps/agent/package.json` + wire the Anthropic client wrap once Workers support is verified; (d) `Env` needs a `GITHUB_REPO_DEFAULT_BRANCH` binding if we want to avoid hardcoding `main` in GATHER — flagging so infra agent can add it to `alchemy.run.ts` if needed; (e) `ws-events.ts` LogMsg is available but not wired — state machine currently relies on structured logger only; consider using `emit({ type: "log", … })` for incident-scoped debugging events if the dashboard wants them. Nothing in `lib/ws-events.ts` was missing for this scaffold.

## Demo Target

Outcome: the demo app visibly breaks, emits useful logs, and can be reset to a known good state.
Depends on: none for local UI work; full loop depends on `ClickHouse And Ingestion`.
Parallel: `Foundation`, `Workspace Runtime`, `Dashboard` shell work.

- [x] Replace the starter homepage with the health-dot surface and a stable failure route.
- [x] Add an in-memory 5xx rate counter over the recent window.
- [x] Make the planted bug yield a mappable stack trace in the demo repo.
- [x] Implement `scripts/plant-bug.ts` and `scripts/reset-bug.ts` around the GitHub repo flow.
- [x] Ship a waitlist landing on `/` (hero + 5pm IST demo note + email capture).
- [x] Wire demo worker tail consumer to `olly-tail`.
- Handoff (health + boom pass): waitlist landing at `/` is untouched; added health-dot and stable-failure surface on top. In-memory 5xx ring buffer lives at module scope in `apps/demo/src/lib/health.ts` (`recordStatus`, `getRate`, `getWindowMs`, 30s window, per-isolate). Wrapped the worker's response pipeline with a custom server entry at `apps/demo/src/server.ts` (`tanstackStart({ server: { entry: "./src/server.ts" } })` in `vite.config.ts`) that delegates to `createStartHandler(defaultStreamHandler)` and calls `recordStatus(response.status)` on every final Response — including 500s produced when a route handler throws. `getHealth` server fn + `HealthSnapshot` type live in `apps/demo/src/lib/get-health.ts` (threshold 3 → red). `HealthDot` component (`apps/demo/src/components/HealthDot.tsx`) polls it every 3s via `setInterval` and renders a colored dot with tooltip `<rate> 5xx in last 30s (threshold 3)` in `Header.tsx` next to the github link. Stable failure route: `/boom` (`apps/demo/src/routes/boom.tsx`) uses TanStack Start's file-route `server.handlers.GET`. Calls `computeTotal(demoCart())` from `apps/demo/src/lib/price.ts`. Healthy response: `Response.json({ total })` (200). On throw the handler emits a `demo.boom_failed` wide event (level=error, structured stack) via a local `createLogger` mirror at `apps/demo/src/lib/log.ts` (inlined so the demo repo stays standalone but with the exact same JSON shape as root `lib/log.ts`), then rethrows so the framework's 500 propagates and the ring-buffer wrap counts it. Planted bug design: the single line `const line = (item: CartItem) => item.price * item.qty;` in `apps/demo/src/lib/price.ts` (with comment `// HEALTHY: do not remove` directly above it) becomes `const line = (item: CartItem) => item.meta.price * item.qty;` — throws `TypeError: Cannot read properties of undefined (reading 'price')` with a stack that maps straight to `src/lib/price.ts` in the demo repo. Scripts: `scripts/plant-bug.ts` and `scripts/reset-bug.ts` are now specialized wrappers around `runGitHubContentsMutation` that hardcode path/find/replace/message (commit messages `chore: plant demo bug` / `chore: reset demo bug`) and only pass through `--dry-run` / `--branch` / `--help`. Marker strings the scripts rely on: path=`src/lib/price.ts`, healthy line=`const line = (item: CartItem) => item.price * item.qty;`, planted line=`const line = (item: CartItem) => item.meta.price * item.qty;`. Files changed: `apps/demo/src/lib/health.ts` (new), `apps/demo/src/lib/price.ts` (new), `apps/demo/src/lib/get-health.ts` (new), `apps/demo/src/lib/log.ts` (new, mirror of root lib/log.ts), `apps/demo/src/server.ts` (new, custom server entry), `apps/demo/src/routes/boom.tsx` (new), `apps/demo/src/components/HealthDot.tsx` (new), `apps/demo/src/components/Header.tsx` (added dot), `apps/demo/src/routeTree.gen.ts` (regenerated), `apps/demo/vite.config.ts` (points tanstackStart at custom server entry), `scripts/plant-bug.ts`, `scripts/reset-bug.ts`. No deps added. No changes to `apps/demo/alchemy.run.ts`, `apps/demo/package.json`, migrations, or `apps/demo/.gitignore`/`README.md`. Commands: `bunx tsc --noEmit -p apps/demo/tsconfig.json` (clean), `bun run scripts/plant-bug.ts --help`, `bun run scripts/reset-bug.ts --help`, `cd apps/demo && bunx tsr generate`. Blockers: (1) the demo worker still needs to be deployed for the health dot / /boom to be reachable — not run per instructions (no `alchemy deploy`, no second `alchemy dev`). (2) The planted bug targets `src/lib/price.ts` in `muzzlol/olly-demo-app`; that repo needs the new `price.ts` and `boom.tsx` files committed + deployed before plant-bug can find the healthy marker. (3) Root `bun run dev` is currently crashing on missing `DASHBOARD_WS_SHARED_SECRET` in `lib/env.ts` — pre-existing, unrelated to this pass, out of scope (apps/demo is not part of root dev).
- Handoff (waitlist pass): `apps/demo` now renders a shadcn-styled waitlist landing at `/` (hero, `5:00 PM IST` badge, email form, sonner toasts). Starter routes (`demo.start.*`, `api.demo-names`) removed. Stack: Tailwind v4 + shadcn "new-york" OKLCH theme (dark by default) scaffolded by hand — `components.json`, `src/lib/utils.ts`, `src/components/ui/{button,input,label,card,sonner}.tsx`, `src/styles.css` rewritten with `@theme inline` + `tw-animate-css`. Deps added: `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `sonner`, `tw-animate-css`, `@radix-ui/react-slot`, `@radix-ui/react-label`, `@tanstack/router-cli` (dev). Waitlist storage: Cloudflare D1 (`olly-demo-waitlist`) provisioned via `apps/demo/alchemy.run.ts` with `migrationsDir: "./migrations"`. Schema: `apps/demo/migrations/0001_waitlist.sql` — `waitlist(id, email UNIQUE, source, user_agent, created_at)`. Server entry: `joinWaitlist` server fn in `src/routes/index.tsx` validates email, dedupes on conflict, inserts via `env.DB.prepare().bind().run()`, emits a structured `waitlist.joined` wide event with fnv1a-hashed email (no PII in logs). Tail wiring: `TanStackStart("website", { tailConsumers: [{ service: process.env.OLLY_TAIL_SERVICE ?? "olly-tail" }] })` — demo worker pushes logs into the root `olly-tail` by service name so the demo repo stays standalone. Files changed: `apps/demo/alchemy.run.ts`, `apps/demo/package.json`, `apps/demo/components.json`, `apps/demo/.gitignore`, `apps/demo/src/styles.css`, `apps/demo/src/routes/__root.tsx`, `apps/demo/src/routes/index.tsx`, `apps/demo/src/components/Header.tsx`, `apps/demo/src/components/ui/*`, `apps/demo/src/lib/utils.ts`, `apps/demo/migrations/0001_waitlist.sql`. Files removed: `apps/demo/src/routes/demo.start.api-request.tsx`, `apps/demo/src/routes/demo.start.server-funcs.tsx`, `apps/demo/src/routes/api.demo-names.ts`. Commands: `bun add class-variance-authority clsx tailwind-merge lucide-react sonner tw-animate-css @radix-ui/react-slot @radix-ui/react-label` + `bun add -D @tanstack/router-cli` (from `apps/demo`), `bunx tsr generate`, `bunx tsc --noEmit --pretty false` (0 errors). Not yet done: health-dot surface, `/boom` stable failure route, 5xx counter, plant/reset bug scripts — intentionally deferred per user scope ("waitlist only on /"). Env: set `OLLY_TAIL_SERVICE` in `apps/demo/.env` to override the default `olly-tail` binding. To test: from repo root `bun run dev` (brings up tail/agent/dashboard), then inside `apps/demo` run `alchemy dev` — D1 migrations apply locally on first run. Blockers: demo repo needs `alchemy deploy` against the Cloudflare account that owns `olly-tail` before tail routing starts delivering.

## Dashboard

Outcome: the dashboard is the primary demo surface and reflects the agent loop live.
Depends on: `Foundation` for the app shell; `Workspace Runtime` for the live stream contract.
Parallel: shell work can start before live events exist.

- [x] Scaffold `apps/dashboard` as a TanStack Start app under the root workspace.
- [x] Build the split view with the six-state machine on the left and live event stream on the right.
- [x] Render tool calls, token stream, diff output, PR link, and obvious out-of-scope incidents.
- [x] Add demo controls only where the backend flow exists; keep fake GitHub App install clearly marked if it remains a stub.
- Handoff: Dashboard UI shell is live at `apps/dashboard/src/routes/index.tsx` (`/`). Split view renders a left-pane SVG state machine (`apps/dashboard/src/components/state-machine.tsx`) with the six canonical states from `lib/ws-events.ts#INCIDENT_STATES` plus an "IDLE" pill when `state === "IDLE"`; the active node pulses via an inline SVG `<animate>`. Right pane (`apps/dashboard/src/components/event-stream.tsx`) renders a chronological list where consecutive `token` chunks with the same `turn` are coalesced into a single streaming paragraph, `tool_call` rows expand to show pretty-printed args and attach their matching `tool_result` (ok/error badge + summary + expandable detail), `diff` rows render a CSS-highlighted unified diff (`.olly-diff-add/.olly-diff-del/.olly-diff-hunk` in `src/styles.css`), `pr_url` renders as a prominent "Open PR" anchor button, and `incident_out_of_scope` is an amber banner carrying the reason. The reducer lives in `apps/dashboard/src/lib/incident-store.ts` (`useIncidentStore`) — one store is shared between the live WS and the mock replay so both feed the same UI. The WS client (`apps/dashboard/src/lib/ws.ts`, `useAgentSocket`) reads `import.meta.env.VITE_AGENT_WS_URL` (default `ws://localhost:1337/ws`), pings every 20s, auto-reconnects with exponential backoff capped at 5s, and goes silent while the mock toggle is active so the two streams cannot fight. Mock generator: `apps/dashboard/src/lib/mock-stream.ts#replayMockStream` plays `signal → incident_started → state:TRIAGE → tool_call/result (get_error_rate) → state:GATHER → tool_call/result (git clone) → state:HYPOTHESIZE → 43 token chunks → state:PATCH → diff → state:PR → pr_url → state:MONITOR → incident_resolved`. Header (`apps/dashboard/src/components/header.tsx`) shows the Olly wordmark, `PROTOCOL_VERSION` from `lib/ws-events.ts`, a connection dot (green when WS open), a "Demo replay" button, plus "Trigger demo (stub)" and "Install GitHub App (demo stub)" buttons that open a simple modal (`src/components/stub-modal.tsx`) explaining the backend is not wired yet. Dark theme uses the exact OKLCH tokens from `apps/demo/src/styles.css` (copied, not edited); `<html>` is forced to `.dark` in `src/routes/__root.tsx`. WS message types consumed (all imported from `lib/ws-events.ts`): `HelloMsg`, `PongMsg`, `StateMsg`, `IncidentStartedMsg`, `IncidentResolvedMsg`, `IncidentOutOfScopeMsg`, `IncidentResetMsg`, `SignalMsg`, `ToolCallMsg`, `ToolResultMsg`, `TokenMsg`, `DiffMsg`, `PrUrlMsg`, `LogMsg`, `ErrorMsg`, plus `ClientMessage` (ping/subscribe) for outbound. Files changed: `apps/dashboard/package.json`, `apps/dashboard/src/styles.css`, `apps/dashboard/src/routes/__root.tsx`, `apps/dashboard/src/routes/index.tsx`, and new files `apps/dashboard/src/lib/{utils,ws,incident-store,mock-stream}.ts`, `apps/dashboard/src/components/{header,state-machine,event-stream,stub-modal}.tsx`, `apps/dashboard/src/components/ui/{button,card,badge,separator,scroll-area}.tsx`. Deps added (via `bun add` in `apps/dashboard`): `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `tw-animate-css`, `@radix-ui/react-slot`, `@radix-ui/react-scroll-area`, `@radix-ui/react-separator`. `vite.config.ts` untouched. Commands run: `bun add …` (dashboard only), `bunx tsc --noEmit -p apps/dashboard/tsconfig.json --pretty false` (passes cleanly), and a dev-browser smoke test that navigates to `http://localhost:5175/`, clicks "Demo replay", and verifies the body contains the resolved badge, `order.amount` diff line, and `Open PR` button. Blocked: none for the UI shell — live WS will start producing once the agent worker plumbs `lib/ws-events.ts` messages through the DO hibernation API. Note: `lucide-react` 1.8.0 does not export a `Github` icon, so "Install GitHub App" uses `GitPullRequest`; swap once the icon set ships it.

## Investigation Loop

Outcome: one severe signal can traverse `TRIAGE -> GATHER -> HYPOTHESIZE -> PATCH -> PR -> MONITOR`.
Depends on: `Workspace Runtime`, `ClickHouse And Ingestion`, `Demo Target`, decision outcomes that affect triage and cloning.
Parallel: dashboard refinement can continue once event payloads exist.

- [ ] Implement `TRIAGE` dedupe, rate checks, and `detected but out of scope` exits.
- [ ] Implement `GATHER` log pulls, deploy lookup, and repo clone into the workspace FS.
- [ ] Implement `HYPOTHESIZE` inside codemode with tool-driven context only.
- [ ] Implement `PATCH` diff generation restricted to stack-trace-mappable repo files.
- [ ] Implement `PR` branch, commit, push, and PR creation against `muzzlol/olly-demo-app`.
- [ ] Implement `MONITOR` with DO alarms, demo-mode timers, and deterministic fallback handling.
- Handoff: capture one real incident transcript or replay artifact as each state stabilizes.

## Ops And Reset Flows

Outcome: the system can be reset and rerun without manual cleanup.
Depends on: relevant backend pieces landing.
Parallel: can advance incrementally during every phase.

- [x] Implement `scripts/reset-incident.ts`.
- [-] Make `DEMO_MODE` a single cross-cutting config honored by timers, model caps, and fallback paths.
- [x] Tighten secrets loading and env validation across root and app workers.
- [x] Replace starter README content with operator setup, deploy, and demo run steps.
- Handoff: Added `lib/env.ts` — `validateRootEnv()` is called at the top of `alchemy.run.ts` and throws listing missing keys. Also exports `getDemoConfig({ DEMO_MODE })` returning `{ isDemo, monitorWindowMs, sandboxTimeoutMs, modelTimeoutMs, hypothesizeTurnCap, hypothesizeWallMs }` — demo: 30s/15s/20s/8/60s; prod: 10min/60s/60s/8/60s. The `WORKSPACE_RUNTIME` agent should import `getDemoConfig` from `lib/env.ts` and thread it through MONITOR alarms, sandbox timeouts, and model call timeouts to finish the cross-cutting wire. `DASHBOARD_WS_SHARED_SECRET` is intentionally not in the required list because `alchemy.run.ts` has a `dev-secret` fallback — tighten once we have a real prod secret in `.env`. `redactSecret(value)` helper is available for debug prints. Also added `scripts/smoke.ts` + `smoke` npm script: HTTP on 1337/1340/5175, CH `SELECT 1`, WS `hello` frame with 3s timeout. `scripts/bootstrap-ch.ts` now has `--help` and structured missing-env errors. README rewritten top-to-bottom for operators. Files changed: `lib/env.ts` (new), `alchemy.run.ts` (import + one-liner call), `scripts/bootstrap-ch.ts`, `scripts/smoke.ts` (new), `package.json` (added `smoke`), `README.md`. Commands: `bunx tsc --noEmit --pretty false --target ESNext --module Preserve --moduleResolution bundler --allowImportingTsExtensions --lib ESNext --types bun --skipLibCheck lib/env.ts scripts/smoke.ts scripts/bootstrap-ch.ts alchemy.run.ts`, `bun run smoke`. Blockers: demo-mode cross-cutting still needs wiring inside `apps/agent/**` (DO alarm window, sandbox exec, model call) — left `[-]`.

## End To End

Outcome: the full demo is repeatable from bad deploy to merged fix to recovered health.
Depends on: all build phases.
Parallel: none.

- [ ] Smoke test root deploy, ClickHouse insert, DO wakeup, WS stream, repo clone, PR creation, and monitor recovery.
- [ ] Verify the dashboard shows state transitions, tool calls, token chunks, diff, and the PR URL.
- [ ] Verify merge plus monitor returns the demo health dot to green.
- [ ] Capture rough edges that should become follow-up work, not MVP blockers.
- Handoff: `bun run smoke` against the running `bun run dev` loop passes 5/5 locally:
  ```
  {"name":"agent.http","ok":true,"detail":{"url":"http://localhost:1337","status":200,"ms":12}}
  {"name":"tail.http","ok":true,"detail":{"url":"http://localhost:1340","status":500,"ms":3}}
  {"name":"dashboard.http","ok":true,"detail":{"url":"http://localhost:5175","status":200,"ms":25}}
  {"name":"clickhouse.select_1","ok":true,"detail":{"rows":1,"ms":1902}}
  {"name":"agent.ws_hello","ok":true,"detail":{"url":"ws://localhost:1337/ws","firstFrame":{"protocol":1,"state":"IDLE","ts":"2026-04-19T10:23:47.825Z","type":"hello"},"ms":17}}
  {"event":"smoke.result","total":5,"passed":5,"failed":0}
  ```
  Tail returns HTTP 500 under `workerd` local dev (no fetch handler — 1101 on deployed CF). Smoke accepts 200/500/1101 for that check. Agent DO already emits `{type:"hello",state:"IDLE",protocol:1}` on WS accept so the smoke contract matches reality. End-to-end path (plant bug → CH → signal → DO → PR → MONITOR) is still blocked on the investigation loop pieces in `Workspace Runtime` / `Investigation Loop`.

test everything that makes sense to test - don't write test files if they will evolve. use dev-browser @dev-browser-instructions.md to test out ui flows. view logs for apps in logs/ while working, Stop using noisy logs. Use structured, context-rich “wide events” instead, good logging will help us build the app out faster lib/log.ts.
