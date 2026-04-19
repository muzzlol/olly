#!/usr/bin/env bun
import { runGitHubContentsMutation } from "./lib/github-contents.ts";

await runGitHubContentsMutation("reset", Bun.argv.slice(2));
