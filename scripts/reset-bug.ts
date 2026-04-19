#!/usr/bin/env bun
import { runGitHubContentsMutation } from "./lib/github-contents.ts";

// Inverse of plant-bug.ts — swaps the planted `.meta.price` line back to the
// healthy `item.price` line on src/lib/price.ts in `muzzlol/olly-demo-app`.

const PATH = "src/lib/price.ts";
const HEALTHY_LINE =
  "const line = (item: CartItem) => item.price * item.qty;";
const PLANTED_LINE =
  "const line = (item: CartItem) => item.meta.price * item.qty;";
const MESSAGE = "chore: reset demo bug";

const argv = Bun.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  writeHelp();
  process.exit(0);
}

await runGitHubContentsMutation("reset", [
  "--path",
  PATH,
  "--find",
  PLANTED_LINE,
  "--replace",
  HEALTHY_LINE,
  "--message",
  MESSAGE,
  ...argv,
]);

function writeHelp() {
  process.stdout.write(
    [
      "Usage: bun --env-file=.env run scripts/reset-bug.ts [--dry-run] [--branch <name>]",
      "",
      "Resets the demo bug by swapping the planted `.meta.price` line back to",
      "the healthy `item.price` line on `src/lib/price.ts` in muzzlol/olly-demo-app.",
      "",
      `  path    ${PATH}`,
      `  find    ${PLANTED_LINE}`,
      `  replace ${HEALTHY_LINE}`,
      `  message ${MESSAGE}`,
      "",
      "Flags:",
      "  --dry-run        Validate without committing",
      "  --branch <name>  Override default branch (default: GITHUB_REPO_DEFAULT_BRANCH or main)",
      "  -h, --help       Show this help text",
      "",
      "Required env: GITHUB_PAT",
      "Optional env: GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_REPO_DEFAULT_BRANCH",
      "",
    ].join("\n"),
  );
}
