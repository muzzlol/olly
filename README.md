# olly

the always on, on-call engineer

this you with olly :)
![sleep ez](bedge-pepe-sleep.gif)

## flow d
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

## State machine

One workspace DO per workspace. Incidents run sequentially inside it (single-tier). States:

1. `TRIAGE` — dedupe against recent incidents in ClickHouse, check error rate, LLM decides real vs noise.
2. `GATHER` — pull recent logs, recent deploys, clone repo via shell/git into the workspace FS.
3. `HYPOTHESIZE` — agent runs in codemode sandbox with state + git + ClickHouse tools; reasons freely, calls whatever it needs, produces a root-cause hypothesis.
4. `PATCH` — agent edits files in the workspace FS, produces a diff.
5. `PR` — branch, commit, push, open PR via GitHub API; post PR link to dashboard.
6. `MONITOR` — DO alarm sleeps for 10min (30s in demo mode), wakes, queries ClickHouse for same error signature, marks incident resolved or escalated.


## Repo layout

```
olly/
  alchemy.run.ts     root infra: tail + agent + dashboard + DO + secrets
  apps/tail/         tail Worker: log batcher -> ClickHouse + DO signal
  apps/agent/        agent Worker: Workspace DO, WS upgrade, 6-state machine
  apps/dashboard/    TanStack Start dashboard (primary demo surface)
  apps/demo/         separate git repo muzzlol/olly-demo-app (gitignored)
  lib/               shared modules (log, env, incident, ws-events)
  scripts/           ops scripts (bootstrap-ch, query-ch, plant/reset-bug, smoke)
  logs/              tee'd output from `bun run dev`
```

```
bun run dev
```

Brings up `olly-tail`, `olly-agent`, `olly-dashboard` under `alchemy dev`
(workerd) and tees to `logs/dev.log`.

Smoke test the loop:

```
bun run smoke
```

## Demo run

1. Start `bun run dev` and open the dashboard at http://localhost:5175/.
2. Plant the bug (commits to `muzzlol/olly-demo-app:main`):
   ```
   bun run demo:plant-bug --path <file> --find <old> --replace <new>
   ```
   (`plant-bug.ts` is still a generic mutation stub until the demo bug path
   is frozen. See `bun run demo:plant-bug --help`.)
3. Watch the dashboard: signal arrives from tail, Workspace DO walks
   TRIAGE → GATHER → HYPOTHESIZE → PATCH → PR.
4. Merge the PR on GitHub.
5. MONITOR waits 30s (demo mode) / 10min (prod), rechecks ClickHouse,
   resolves the incident.

## Reset

```
bun run demo:reset-bug --path <file> --find <new> --replace <old>
bun run incident:reset --reason rerun_demo
```

`incident:reset` POSTs to the agent's `/internal/reset-incident` and
clears the in-memory DO state back to `IDLE`. Requires
`DASHBOARD_WS_SHARED_SECRET` and `AGENT_URL` in env, or `--url`.

## Troubleshooting

- **Port conflicts**: `bun run dev` is the only thing that should own
  1337/1340/5175. If `alchemy dev` logs
  `Port N is already in use, trying N+1`, a stale process is lingering —
  find it with `lsof -nP -iTCP:1337 -sTCP:LISTEN` and kill it.
- **Missing tail consumer**: if logs aren't landing in ClickHouse,
  confirm `apps/demo/alchemy.run.ts` still declares
  `tailConsumers: [{ service: "olly-tail" }]` and has been redeployed.
- **Bad ClickHouse creds**: `bun run ch:query` will print the server error
  directly. Cross-check `CLICKHOUSE_HTTPS_URL`, `CLICKHOUSE_USER`,
  `CLICKHOUSE_PASSWORD` in `.env`.
- **Agent WS never opens**: `bun run smoke` will fail on `agent.ws_hello`.
  Usually means the agent worker is down — check `logs/dev.log`.
- **`validateRootEnv` throws at boot**: the error lists the missing keys.
  Fill them in `.env` and re-run.

## Scripts

| script                     | purpose |
| -------------------------- | ------- |
| `bun run dev`              | alchemy dev for the three root workers |
| `bun run deploy`           | alchemy deploy (prod) |
| `bun run destroy`          | alchemy destroy (prod) |
| `bun run ch:bootstrap`     | create the `logs` table |
| `bun run ch:query [sql]`   | read-only CH probe |
| `bun run smoke`            | local dev loop sanity |
| `bun run demo:plant-bug`   | mutate a file in the demo repo |
| `bun run demo:reset-bug`   | revert said mutation |
| `bun run incident:reset`   | reset the workspace DO to IDLE |



1. Open dashboard: https://olly-olly-dashboard-muzz.muzzz.workers.dev
2. Run: bun run demo:plant-bug
3. Watch state machine: TRIAGE → GATHER → HYPOTHESIZE → PATCH → PR
4. Click the PR link, merge it on GitHub
5. Wait ~30s for MONITOR to verify → incident resolved
Reset for next run:
bun run demo:reset-bug
bun run incident:reset