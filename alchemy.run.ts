import alchemy from "alchemy";
import {
  DurableObjectNamespace,
  TanStackStart,
  Worker,
  WorkerLoader,
} from "alchemy/cloudflare";
import { validateRootEnv } from "./lib/env.ts";
import { createLogger } from "./lib/log.ts";

validateRootEnv();

const phase = process.env.DESTROY ? "destroy" : "up";
const log = createLogger("alchemy", { phase });

const app = await alchemy("olly", {
  phase,
});

// -- Secrets --
const zenKey = alchemy.secret(process.env.OPENCODE_ZEN_API_KEY);
const chUrl = alchemy.secret(process.env.CLICKHOUSE_HTTPS_URL);
const chUser = alchemy.secret(process.env.CLICKHOUSE_USER);
const chPassword = alchemy.secret(process.env.CLICKHOUSE_PASSWORD);
const chDatabase = process.env.CLICKHOUSE_DATABASE ?? "default";
const githubPat = alchemy.secret(process.env.GITHUB_PAT);
const githubOwner = process.env.GITHUB_REPO_OWNER ?? "muzzlol";
const githubRepo = process.env.GITHUB_REPO_NAME ?? "olly-demo-app";
const wsSecret = alchemy.secret(
  process.env.DASHBOARD_WS_SHARED_SECRET ?? "dev-secret",
);
const demoMode = process.env.DEMO_MODE ?? "1";

// -- Durable Object namespace (agent workspace, SQLite-backed) --
const workspace = DurableObjectNamespace("workspace", {
  className: "WorkspaceDO",
  sqlite: true,
});

// -- Agent Worker (hosts the workspace DO) --
const agent = await Worker("olly-agent", {
  entrypoint: "./apps/agent/src/worker.ts",
  url: true,
  adopt: true,
  compatibility: "node",
  bindings: {
    WORKSPACE: workspace,
    LOADER: WorkerLoader(),
    OPENCODE_ZEN_API_KEY: zenKey,
    CLICKHOUSE_URL: chUrl,
    CLICKHOUSE_USER: chUser,
    CLICKHOUSE_PASSWORD: chPassword,
    CLICKHOUSE_DATABASE: chDatabase,
    GITHUB_PAT: githubPat,
    GITHUB_REPO_OWNER: githubOwner,
    GITHUB_REPO_NAME: githubRepo,
    DASHBOARD_WS_SHARED_SECRET: wsSecret,
    DEMO_MODE: demoMode,
  },
});

// -- Tail Worker --
const tail = await Worker("olly-tail", {
  entrypoint: "./apps/tail/src/index.ts",
  url: true,
  adopt: true,
  bindings: {
    CLICKHOUSE_URL: chUrl,
    CLICKHOUSE_USER: chUser,
    CLICKHOUSE_PASSWORD: chPassword,
    CLICKHOUSE_DATABASE: chDatabase,
    AGENT_URL: agent.url ?? "",
  },
});

// -- Dashboard (TanStack Start) --
const dashboard = await TanStackStart("olly-dashboard", {
  cwd: "./apps/dashboard",
  adopt: true,
  bindings: {
    AGENT_URL: agent.url ?? "",
    DASHBOARD_WS_SHARED_SECRET: wsSecret,
  },
});

log.info("deploy.resources_ready", {
  tailUrl: tail.url,
  agentUrl: agent.url,
  dashboardUrl: dashboard.url,
});

console.log("\n  URLs");
console.log(`    tail      ${tail.url ?? "(no url)"}`);
console.log(`    agent     ${agent.url ?? "(no url)"}`);
console.log(`    dashboard ${dashboard.url ?? "(no url)"}\n`);

await app.finalize();
