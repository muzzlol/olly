# olly

the always on, on-call engineer.

this you with olly

![this you with olly](bedge-pepe-sleep.gif)

Apps in apps/
Four apps, three in the monorepo + one separate repo:
1. apps/tail/ — Log pipe Worker
Receives every log from the demo app (Cloudflare Tail Worker). Batches inserts into ClickHouse. If log is severe, RPCs the agent DO to wake up. No fetch handler.
2. apps/agent/ — The brain
Hosts the Workspace Durable Object. Runs the 6-state investigation machine per incident. Calls the LLM, holds the virtual FS (DO SQLite), executes tools in a codemode sandbox. Exposes a WebSocket upgrade endpoint for the dashboard.
3. apps/dashboard/ — The demo surface
TanStack Start app. Shows the live state machine + streaming tool calls, tokens, diff, PR link. Opens a WebSocket to the agent DO. Also hosts demo controls (plant bug button).
4. apps/demo/ — The victim
TanStack Start Worker with a health dot on its homepage. Separate git repo (muzzlol/olly-demo-app), gitignored from the monorepo, deployed independently via its own alchemy.run.ts. Its logs flow into olly-tail. Gets the planted bug committed to it to trigger the demo.
How they relate
apps/demo   ──logs──►  apps/tail  ──►  ClickHouse
                           │
                           └──signal──►  apps/agent (Workspace DO)
                                              │
                                              └──WebSocket──►  apps/dashboard