#!/usr/bin/env bun
import { runGitHubContentsMutation } from "./lib/github-contents.ts";

await runGitHubContentsMutation("plant", Bun.argv.slice(2));
