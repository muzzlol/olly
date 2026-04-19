import { createLogger, type Logger } from "../../lib/log.ts";

interface Options {
  readonly help: boolean;
  readonly dryRun: boolean;
  readonly branch: string;
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly message: string;
}

interface RepoConfig {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
}

interface GitHubFile {
  readonly sha: string;
  readonly content: string;
  readonly encoding: string;
}

interface GitHubUpdateResponse {
  readonly commit: {
    readonly sha: string;
    readonly html_url?: string;
  };
}

type Mode = "plant" | "reset";

export async function runGitHubContentsMutation(
  mode: Mode,
  argv: string[],
): Promise<void> {
  const script = mode === "plant" ? "plant-bug" : "reset-bug";
  const log = createLogger(script);
  const opts = parseArgs(argv, defaultMessage(mode), log, script, mode);

  if (opts.help) {
    writeUsage(script, mode);
    return;
  }

  const repo = loadRepoConfig(log);
  const branch = opts.branch || repo.defaultBranch;
  const url = buildContentsUrl(repo.owner, repo.repo, opts.path, branch);

  log.info("github.contents_fetch_start", {
    owner: repo.owner,
    repo: repo.repo,
    branch,
    path: opts.path,
    mode,
    dryRun: opts.dryRun,
  });

  const file = await readGitHubFile(url, repo.token, log, opts.path, branch);
  const before = decodeContents(file, log, opts.path, branch);

  if (!before.includes(opts.find)) {
    log.error("github.contents_marker_missing", {
      owner: repo.owner,
      repo: repo.repo,
      branch,
      path: opts.path,
      mode,
      find: opts.find,
    });
    process.exit(1);
  }

  const after = before.replace(opts.find, opts.replace);

  if (after === before) {
    log.error("github.contents_noop", {
      owner: repo.owner,
      repo: repo.repo,
      branch,
      path: opts.path,
      mode,
    });
    process.exit(1);
  }

  if (opts.dryRun) {
    log.info("github.contents_update_dry_run", {
      owner: repo.owner,
      repo: repo.repo,
      branch,
      path: opts.path,
      mode,
      beforeBytes: before.length,
      afterBytes: after.length,
      message: opts.message,
    });
    return;
  }

  const result = await writeGitHubFile(
    url,
    repo.token,
    {
      branch,
      content: after,
      message: opts.message,
      sha: file.sha,
    },
    log,
    opts.path,
  );

  log.info("github.contents_update_done", {
    owner: repo.owner,
    repo: repo.repo,
    branch,
    path: opts.path,
    mode,
    commitSha: result.commit.sha,
    commitUrl: result.commit.html_url,
  });
}

function parseArgs(
  argv: string[],
  defaultMsg: string,
  log: Logger,
  script: string,
  mode: Mode,
): Options {
  let help = false;
  let dryRun = false;
  let branch: string | null = null;
  let path: string | null = null;
  let find: string | null = null;
  let replace: string | null = null;
  let message: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--branch") {
      branch = readValue(argv, i, arg, log, script, mode);
      i += 1;
      continue;
    }

    if (arg === "--path") {
      path = readValue(argv, i, arg, log, script, mode);
      i += 1;
      continue;
    }

    if (arg === "--find") {
      find = readValue(argv, i, arg, log, script, mode);
      i += 1;
      continue;
    }

    if (arg === "--replace") {
      replace = readValue(argv, i, arg, log, script, mode);
      i += 1;
      continue;
    }

    if (arg === "--message") {
      message = readValue(argv, i, arg, log, script, mode);
      i += 1;
      continue;
    }

    failUsage(log, script, mode, `unknown argument: ${arg}`);
  }

  if (help) {
    return {
      help,
      dryRun,
      branch: branch ?? "",
      path: path ?? "",
      find: find ?? "",
      replace: replace ?? "",
      message: message ?? defaultMsg,
    };
  }

  if (path === null) {
    failUsage(log, script, mode, "missing --path");
  }

  if (!path.length) {
    failUsage(log, script, mode, "--path cannot be empty");
  }

  if (find === null) {
    failUsage(log, script, mode, "missing --find");
  }

  if (!find.length) {
    failUsage(log, script, mode, "--find cannot be empty");
  }

  if (replace === null) {
    failUsage(log, script, mode, "missing --replace");
  }

  return {
    help,
    dryRun,
    branch: branch ?? "",
    path,
    find,
    replace,
    message: message ?? defaultMsg,
  };
}

function readValue(
  argv: string[],
  index: number,
  flag: string,
  log: Logger,
  script: string,
  mode: Mode,
): string {
  if (index + 1 < argv.length) {
    return argv[index + 1] ?? "";
  }

  failUsage(log, script, mode, `missing value for ${flag}`);
}

function loadRepoConfig(log: Logger): RepoConfig {
  const token = process.env.GITHUB_PAT;
  const owner = process.env.GITHUB_REPO_OWNER ?? "muzzlol";
  const repo = process.env.GITHUB_REPO_NAME ?? "olly-demo-app";
  const defaultBranch = process.env.GITHUB_REPO_DEFAULT_BRANCH ?? "main";

  if (token) {
    return { token, owner, repo, defaultBranch };
  }

  log.error("github.missing_env", {
    hasToken: Boolean(token),
    owner,
    repo,
    defaultBranch,
  });
  process.exit(1);
}

function buildContentsUrl(
  owner: string,
  repo: string,
  path: string,
  branch: string,
): string {
  const cleanPath = path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`;
}

async function readGitHubFile(
  url: string,
  token: string,
  log: Logger,
  path: string,
  branch: string,
): Promise<GitHubFile> {
  const response = await fetch(url, {
    headers: githubHeaders(token),
  });

  if (!response.ok) {
    const body = await response.text();
    log.error("github.contents_fetch_failed", {
      path,
      branch,
      status: response.status,
      body,
    });
    process.exit(1);
  }

  return (await response.json()) as GitHubFile;
}

function decodeContents(
  file: GitHubFile,
  log: Logger,
  path: string,
  branch: string,
): string {
  if (file.encoding === "base64") {
    return Buffer.from(file.content.replace(/\s+/gu, ""), "base64").toString(
      "utf8",
    );
  }

  log.error("github.contents_encoding_unsupported", {
    path,
    branch,
    encoding: file.encoding,
  });
  process.exit(1);
}

async function writeGitHubFile(
  url: string,
  token: string,
  body: {
    readonly branch: string;
    readonly content: string;
    readonly message: string;
    readonly sha: string;
  },
  log: Logger,
  path: string,
): Promise<GitHubUpdateResponse> {
  const response = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify({
      branch: body.branch,
      content: Buffer.from(body.content, "utf8").toString("base64"),
      message: body.message,
      sha: body.sha,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error("github.contents_update_failed", {
      path,
      branch: body.branch,
      status: response.status,
      body: text,
      message: body.message,
    });
    process.exit(1);
  }

  return (await response.json()) as GitHubUpdateResponse;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "olly-scripts",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function writeUsage(script: string, mode: Mode): void {
  const verb = mode === "plant" ? "Plant" : "Reset";
  const defaultMsg = defaultMessage(mode);

  process.stdout.write(
    [
      `Usage: bun --env-file=.env run scripts/${script}.ts [options]`,
      "",
      `${verb}s a demo repo file through the GitHub contents API by replacing one string match.`,
      "This is a generic repo-mutation stub until the demo bug path is frozen.",
      "",
      "Options:",
      "  --path <repo-path>    File to edit in the GitHub repo",
      "  --find <text>         First exact string to replace",
      "  --replace <text>      Replacement string (can be empty)",
      `  --message <text>      Commit message (default: ${defaultMsg})`,
      "  --branch <name>       Branch to mutate (default: GITHUB_REPO_DEFAULT_BRANCH or main)",
      "  --dry-run             Validate fetch + replacement without writing",
      "  -h, --help            Show this help text",
      "",
      "Required env:",
      "  GITHUB_PAT",
      "Optional env:",
      "  GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_REPO_DEFAULT_BRANCH",
      "",
      "Example:",
      `  bun --env-file=.env run scripts/${script}.ts --path src/routes/index.tsx --find 'return ok()' --replace 'throw new Error("boom")' --dry-run`,
      "",
    ].join("\n"),
  );
}

function failUsage(
  log: Logger,
  script: string,
  mode: Mode,
  message: string,
): never {
  log.error("script.invalid_args", { message });
  writeUsage(script, mode);
  process.exit(1);
}

function defaultMessage(mode: Mode): string {
  if (mode === "plant") {
    return "plant demo bug";
  }

  return "reset demo bug";
}
