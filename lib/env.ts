// Central env validation + demo-mode config.
// Keep this file single-purpose and dependency-free so scripts and
// `alchemy.run.ts` can both import it without dragging in runtime code.

export interface DemoModeConfig {
  readonly isDemo: boolean;
  readonly monitorWindowMs: number;
  readonly sandboxTimeoutMs: number;
  readonly modelTimeoutMs: number;
  readonly hypothesizeTurnCap: number;
  readonly hypothesizeWallMs: number;
}

// Secrets required at the root for bootstrap. Mirrors SPEC.md "Secrets".
// Keys with a safe dev fallback in `alchemy.run.ts` (e.g. DASHBOARD_WS_SHARED_SECRET)
// are intentionally left out so `bun run dev` works on a lean `.env`.
// Control-plane ClickHouse creds are only needed for provisioning scripts
// and also live outside this set.
const REQUIRED_ROOT_KEYS = [
  "ALCHEMY_PASSWORD",
  "OPENCODE_ZEN_API_KEY",
  "CLICKHOUSE_HTTPS_URL",
  "CLICKHOUSE_USER",
  "CLICKHOUSE_PASSWORD",
  "CLICKHOUSE_DATABASE",
  "CLICKHOUSE_HOST",
  "CLICKHOUSE_PORT",
  "GITHUB_PAT",
  "GITHUB_REPO_OWNER",
  "GITHUB_REPO_NAME",
  "GITHUB_REPO_DEFAULT_BRANCH",
  "BRAINTRUST_API_KEY",
  "DEMO_MODE",
] as const;

export type RequiredRootKey = (typeof REQUIRED_ROOT_KEYS)[number];

export function validateRootEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const missing = REQUIRED_ROOT_KEYS.filter((key) => !isPresent(env[key]));

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `Missing required env vars: ${missing.join(", ")}. See SPEC.md "Secrets".`,
  );
}

export function requireEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[name];

  if (isPresent(value)) {
    return value;
  }

  throw new Error(`Missing required env var: ${name}`);
}

export function getDemoConfig(env: {
  DEMO_MODE?: string;
}): DemoModeConfig {
  const isDemo = env.DEMO_MODE === "1";

  if (isDemo) {
    return {
      isDemo: true,
      monitorWindowMs: 30_000,
      sandboxTimeoutMs: 15_000,
      modelTimeoutMs: 20_000,
      hypothesizeTurnCap: 8,
      hypothesizeWallMs: 60_000,
    };
  }

  return {
    isDemo: false,
    monitorWindowMs: 10 * 60_000,
    sandboxTimeoutMs: 60_000,
    modelTimeoutMs: 60_000,
    hypothesizeTurnCap: 8,
    hypothesizeWallMs: 60_000,
  };
}

export function redactSecret(value: string | undefined): string {
  if (isPresent(value)) {
    return "***";
  }

  return "(missing)";
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
