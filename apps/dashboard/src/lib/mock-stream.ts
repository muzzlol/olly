import type { IncidentState, ServerMessage } from "../../../../lib/ws-events.ts";

export type MockScenario = "short" | "escalated" | "storm";

const INCIDENT_ID = "demo-incident-001";
const SIGNATURE = "olly-demo-app:handlers/api.ts:42:TypeError";

const HYPOTHESIS_TOKENS: readonly string[] = [
  "Looking ", "at ", "the ", "recent ", "logs, ", "the ", "500s ", "cluster ",
  "around ", "`/api/checkout` ", "after ", "deploy ", "`a3f91c`. ", "The ",
  "stack ", "trace ", "points ", "to ", "`handlers/api.ts:42` ", "where ",
  "we ", "read ", "`order.total` ", "without ", "a ", "guard. ", "The ",
  "planted ", "bug ", "renamed ", "the ", "field ", "to ", "`order.amount` ",
  "but ", "one ", "call ", "site ", "still ", "uses ", "the ", "old ", "name.",
];

const DEMO_DIFF = `diff --git a/src/handlers/api.ts b/src/handlers/api.ts
index 1c3d4e5..2a4b5c6 100644
--- a/src/handlers/api.ts
+++ b/src/handlers/api.ts
@@ -38,7 +38,7 @@ export async function checkout(req: Request) {
   const order = await loadOrder(req)
   if (!order) return new Response("not found", { status: 404 })

-  const total = order.total
+  const total = order.amount
   if (typeof total !== "number") {
     return new Response("bad order", { status: 400 })
   }
`;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface Step {
  delay: number;
  msg: ServerMessage;
}

function signalStep(delay: number): Step {
  return {
    delay,
    msg: {
      type: "signal",
      incidentId: INCIDENT_ID,
      signature: SIGNATURE,
      service: "olly-demo-app",
      errorClass: "TypeError",
      message: "Cannot read properties of undefined (reading 'total')",
      statusCode: 500,
      route: "/api/checkout",
      ts: iso(0),
    },
  };
}

function startedStep(delay: number): Step {
  return {
    delay,
    msg: {
      type: "incident_started",
      incidentId: INCIDENT_ID,
      signature: SIGNATURE,
      service: "olly-demo-app",
      errorClass: "TypeError",
      message: "Cannot read properties of undefined (reading 'total')",
      ts: iso(0),
    },
  };
}

function stateStep(delay: number, state: IncidentState): Step {
  return { delay, msg: { type: "state", state, incidentId: INCIDENT_ID, ts: iso(0) } };
}

function buildShort(): Step[] {
  const steps: Step[] = [];
  steps.push(signalStep(0));
  steps.push(startedStep(250));
  steps.push(stateStep(150, "TRIAGE"));
  steps.push({
    delay: 400,
    msg: {
      type: "tool_call",
      incidentId: INCIDENT_ID,
      callId: "call-1",
      provider: "clickhouse",
      tool: "get_error_rate",
      args: { signature: SIGNATURE, window: "5m" },
      ts: iso(0),
    },
  });
  steps.push({
    delay: 500,
    msg: {
      type: "tool_result",
      incidentId: INCIDENT_ID,
      callId: "call-1",
      ok: true,
      summary: "14 errors in last 5 minutes (rate 2.8/min)",
      detail: { count: 14, rate_per_min: 2.8, window: "5m" },
      ts: iso(0),
    },
  });
  steps.push(stateStep(300, "GATHER"));
  steps.push({
    delay: 350,
    msg: {
      type: "tool_call",
      incidentId: INCIDENT_ID,
      callId: "call-2",
      provider: "git",
      tool: "clone",
      args: { repo: "muzzlol/olly-demo-app", depth: 1, singleBranch: true },
      ts: iso(0),
    },
  });
  steps.push({
    delay: 700,
    msg: {
      type: "tool_result",
      incidentId: INCIDENT_ID,
      callId: "call-2",
      ok: true,
      summary: "Cloned muzzlol/olly-demo-app @ main (depth=1) in 612ms",
      detail: {
        repo: "muzzlol/olly-demo-app",
        branch: "main",
        head: "a3f91cb",
        files: 84,
      },
      ts: iso(0),
    },
  });
  steps.push(stateStep(200, "HYPOTHESIZE"));
  for (const chunk of HYPOTHESIS_TOKENS) {
    steps.push({
      delay: 45,
      msg: {
        type: "token",
        incidentId: INCIDENT_ID,
        turn: 0,
        chunk,
        ts: iso(0),
      },
    });
  }
  steps.push(stateStep(400, "PATCH"));
  steps.push({
    delay: 500,
    msg: {
      type: "diff",
      incidentId: INCIDENT_ID,
      patch: DEMO_DIFF,
      files: ["src/handlers/api.ts"],
      ts: iso(0),
    },
  });
  steps.push(stateStep(300, "PR"));
  steps.push({
    delay: 700,
    msg: {
      type: "pr_url",
      incidentId: INCIDENT_ID,
      url: "https://github.com/muzzlol/olly-demo-app/pull/42",
      number: 42,
      ts: iso(0),
    },
  });
  steps.push(stateStep(400, "MONITOR"));
  steps.push({
    delay: 900,
    msg: {
      type: "incident_resolved",
      incidentId: INCIDENT_ID,
      resolution: "fixed",
      ts: iso(0),
    },
  });
  return steps;
}

/**
 * Scenario where the agent gets partway through GATHER and then bails because
 * the error's stack trace doesn't map to a file in the user's repo. Banner
 * should turn amber and the state machine stays on GATHER.
 */
function buildEscalated(): Step[] {
  const steps: Step[] = [];
  steps.push(signalStep(0));
  steps.push(startedStep(250));
  steps.push(stateStep(150, "TRIAGE"));
  steps.push({
    delay: 300,
    msg: {
      type: "log",
      incidentId: INCIDENT_ID,
      level: "info",
      event: "triage.begin",
      fields: { signature: SIGNATURE },
      ts: iso(0),
    },
  });
  steps.push({
    delay: 350,
    msg: {
      type: "tool_call",
      incidentId: INCIDENT_ID,
      callId: "call-e1",
      provider: "clickhouse",
      tool: "get_error_rate",
      args: { signature: SIGNATURE, window: "5m" },
      ts: iso(0),
    },
  });
  steps.push({
    delay: 550,
    msg: {
      type: "tool_result",
      incidentId: INCIDENT_ID,
      callId: "call-e1",
      ok: true,
      summary: "3 errors in last 5 minutes (rate 0.6/min)",
      detail: { count: 3, rate_per_min: 0.6, window: "5m" },
      ts: iso(0),
    },
  });
  steps.push(stateStep(300, "GATHER"));
  steps.push({
    delay: 400,
    msg: {
      type: "log",
      incidentId: INCIDENT_ID,
      level: "warn",
      event: "gather.stack_frames_missing",
      fields: { signature: SIGNATURE, frames_matched: 0 },
      ts: iso(0),
    },
  });
  steps.push({
    delay: 600,
    msg: {
      type: "incident_out_of_scope",
      incidentId: INCIDENT_ID,
      reason:
        "Stack trace does not map to any file in muzzlol/olly-demo-app. Escalating to on-call.",
      ts: iso(0),
    },
  });
  steps.push({
    delay: 300,
    msg: {
      type: "incident_resolved",
      incidentId: INCIDENT_ID,
      resolution: "escalated",
      ts: iso(0),
    },
  });
  return steps;
}

/**
 * Stress test: 250 token chunks arrive in rapid succession with a couple of
 * log flood bursts mixed in. Makes sure auto-scroll / cap / layout don't
 * choke on heavy streaming.
 */
function buildStorm(): Step[] {
  const steps: Step[] = [];
  steps.push(signalStep(0));
  steps.push(startedStep(200));
  steps.push(stateStep(120, "TRIAGE"));
  steps.push(stateStep(200, "GATHER"));
  steps.push(stateStep(200, "HYPOTHESIZE"));
  const TOKEN_COUNT = 250;
  const WORDS = ["alpha ", "beta ", "gamma ", "delta ", "epsilon ", "zeta ", "eta ", "theta "];
  for (let i = 0; i < TOKEN_COUNT; i++) {
    steps.push({
      delay: 12,
      msg: {
        type: "token",
        incidentId: INCIDENT_ID,
        turn: 0,
        chunk: WORDS[i % WORDS.length]!,
        ts: iso(0),
      },
    });
    if (i === 80 || i === 180) {
      for (let j = 0; j < 25; j++) {
        steps.push({
          delay: 4,
          msg: {
            type: "log",
            incidentId: INCIDENT_ID,
            level: j % 5 === 0 ? "warn" : "debug",
            event: "hypothesize.progress",
            fields: { step: j, turn: 0 },
            ts: iso(0),
          },
        });
      }
    }
  }
  steps.push(stateStep(200, "PATCH"));
  steps.push({
    delay: 400,
    msg: {
      type: "diff",
      incidentId: INCIDENT_ID,
      patch: DEMO_DIFF,
      files: ["src/handlers/api.ts"],
      ts: iso(0),
    },
  });
  steps.push(stateStep(200, "PR"));
  steps.push({
    delay: 400,
    msg: {
      type: "pr_url",
      incidentId: INCIDENT_ID,
      url: "https://github.com/muzzlol/olly-demo-app/pull/43",
      number: 43,
      ts: iso(0),
    },
  });
  steps.push(stateStep(200, "MONITOR"));
  steps.push({
    delay: 500,
    msg: {
      type: "incident_resolved",
      incidentId: INCIDENT_ID,
      resolution: "fixed",
      ts: iso(0),
    },
  });
  return steps;
}

export function buildMockTimeline(scenario: MockScenario = "short"): ReadonlyArray<Step> {
  if (scenario === "escalated") return buildEscalated();
  if (scenario === "storm") return buildStorm();
  return buildShort();
}

/**
 * Drive `emit` through the scripted timeline. Returns a cancel function; call
 * it to abort the replay if the user navigates away or restarts it.
 */
export function replayMockStream(
  emit: (msg: ServerMessage) => void,
  scenario: MockScenario = "short",
): () => void {
  const steps = buildMockTimeline(scenario);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const total = { elapsed: 0 };

  for (const step of steps) {
    total.elapsed += step.delay;
    timers.push(setTimeout(() => emit(step.msg), total.elapsed));
  }

  return () => {
    for (const t of timers) clearTimeout(t);
  };
}
