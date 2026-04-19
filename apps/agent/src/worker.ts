import { createLogger } from "../../../lib/log.ts";
import { WorkspaceDO } from "./workspace-do";

export { WorkspaceDO };

const log = createLogger("olly-agent", {
  component: "worker",
});

export interface Env {
  WORKSPACE: DurableObjectNamespace;
  LOADER: WorkerLoader;
  OPENCODE_ZEN_API_KEY: string;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_PASSWORD: string;
  CLICKHOUSE_DATABASE: string;
  GITHUB_PAT: string;
  GITHUB_REPO_OWNER: string;
  GITHUB_REPO_NAME: string;
  GITHUB_REPO_DEFAULT_BRANCH: string;
  DASHBOARD_WS_SHARED_SECRET: string;
  DEMO_MODE: string;
  DEMO_SKIP_CLONE?: string;
}

const handler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket upgrade for dashboard connections
    if (url.pathname === "/ws") {
      const id = env.WORKSPACE.idFromName("default");
      const stub = env.WORKSPACE.get(id);
      return stub.fetch(request);
    }

    // RPC: tail worker signals
    if (url.pathname === "/signal" && request.method === "POST") {
      const id = env.WORKSPACE.idFromName("default");
      const stub = env.WORKSPACE.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/internal/reset-incident" && request.method === "POST") {
      const secret = request.headers.get("x-dashboard-shared-secret");

      if (secret !== env.DASHBOARD_WS_SHARED_SECRET) {
        log.warn("agent.reset_unauthorized", {
          hasSecret: Boolean(secret),
        });
        return new Response("unauthorized", { status: 401 });
      }

      const id = env.WORKSPACE.idFromName("default");
      const stub = env.WORKSPACE.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/internal/state" && request.method === "GET") {
      const secret = request.headers.get("x-dashboard-shared-secret");

      if (secret !== env.DASHBOARD_WS_SHARED_SECRET) {
        log.warn("agent.state_unauthorized", {
          hasSecret: Boolean(secret),
        });
        return new Response("unauthorized", { status: 401 });
      }

      const id = env.WORKSPACE.idFromName("default");
      const stub = env.WORKSPACE.get(id);
      return stub.fetch(request);
    }

    return new Response("olly-agent", { status: 200 });
  },
};

export default handler;
