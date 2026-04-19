import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("my-first-app");

const worker = await Worker("hello-worker", {
  entrypoint: "./src/worker.ts",
});

console.log(`Worker deployed at: ${worker.url}`);
await app.finalize();
