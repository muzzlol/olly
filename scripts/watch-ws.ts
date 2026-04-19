#!/usr/bin/env bun
// Connect to the agent WS on ws://localhost:1337/ws, print every
// server->client event as pretty JSON for N seconds, then exit.
// Usage: bun run scripts/watch-ws.ts [seconds] [url]

const secs = Number(Bun.argv[2] ?? "6");
const url = Bun.argv[3] ?? "ws://localhost:1337/ws";

const ws = new WebSocket(url);

ws.addEventListener("open", () => {
  process.stdout.write(`# ws open ${url}\n`);
});

ws.addEventListener("message", (ev) => {
  process.stdout.write(`${ev.data}\n`);
});

ws.addEventListener("error", (ev) => {
  process.stderr.write(`# ws error ${String(ev)}\n`);
});

setTimeout(() => {
  ws.close();
  process.exit(0);
}, secs * 1000);
