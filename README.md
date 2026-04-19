# olly

An always-warm, stateful agent per workspace that watches production logs,
decides when something is really broken, investigates, and ships a fix as a
PR — without paging a human. See `SPEC.md` for the full design. This README
is the operator runbook.

![sleep ez](bedge-pepe-sleep.gif)

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

## Prereqs

- Bun (>= 1.2)
- nvm + Node LTS (the dev script `nvm use`'s for workerd compatibility)
- wrangler auth to a Cloudflare account with Workers + DO (`wrangler login`)
- Access to the ClickHouse service at
  `ihguwjq35c.ap-south-1.aws.clickhouse.cloud:8443`
- GitHub fine-grained PAT for `muzzlol/olly-demo-app`

## Setup

```
git clone <this-repo> olly && cd olly
bun install
```

There is no `.env.example` — populate `.env` yourself with the keys listed in
`SPEC.md` under **Secrets**. `lib/env.ts#validateRootEnv` will fail fast at
boot if required keys are missing.

## ClickHouse bootstrap

Run once per environment (idempotent):

```
bun run ch:bootstrap
```

Probe the table any time:

```
bun run ch:query                       # last 20 rows
bun run ch:query "SELECT count() FROM logs"
```

## Dev loop

```
bun run dev
```

Brings up `olly-tail`, `olly-agent`, `olly-dashboard` under `alchemy dev`
(workerd) and tees to `logs/dev.log`.

| service   | URL                      | notes |
| --------- | ------------------------ | ----- |
| agent     | http://localhost:1337/   | `/ws` for dashboard, `/signal` for tail, `/internal/reset-incident` for ops |
| tail      | http://localhost:1340/   | no fetch handler (500/1101 expected) |
| dashboard | http://localhost:5175/   | TanStack vite dev |

Smoke test the loop:

```
bun run smoke
```

Checks HTTP on all three, `SELECT 1` on ClickHouse, and the agent WS first
frame. Exits 1 on any failure.

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
