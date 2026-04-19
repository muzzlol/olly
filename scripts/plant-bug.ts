#!/usr/bin/env bun
import { runGitHubContentsMutation } from "./lib/github-contents.ts";

// Specialized planter for the olly-demo-app demo bug.
//
// Targets src/lib/price.ts on `muzzlol/olly-demo-app` main. The `line` helper
// is the single surface the bug lives on. Swap injects a `.meta` dereference
// that throws `TypeError: Cannot read properties of undefined (reading 'price')`
// when /boom computes a cart total.
//
// The `// HEALTHY: do not remove` marker directly above the line lets
// reset-bug.ts do the inverse swap unambiguously.

const PATH = "src/lib/price.ts";
const HEALTHY_LINE =
  "const line = (item: CartItem) => item.price * item.qty;";
const PLANTED_LINE =
  "const line = (item: CartItem) => item.meta.price * item.qty;";
const MESSAGE = "chore: plant demo bug";

const argv = Bun.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  writeHelp();
  process.exit(0);
}

await runGitHubContentsMutation("plant", [
  "--path",
  PATH,
  "--find",
  HEALTHY_LINE,
  "--replace",
  PLANTED_LINE,
  "--message",
  MESSAGE,
  ...argv,
]);

function writeHelp() {
  process.stdout.write(
    [
      "Usage: bun --env-file=.env run scripts/plant-bug.ts [--dry-run] [--branch <name>]",
      "",
      "Plants the demo bug by swapping one line in `src/lib/price.ts` on",
      "muzzlol/olly-demo-app main. The swap replaces the healthy `line` helper",
      "with a `.meta.price` dereference that throws TypeError at /boom.",
      "",
      `  path    ${PATH}`,
      `  find    ${HEALTHY_LINE}`,
      `  replace ${PLANTED_LINE}`,
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
