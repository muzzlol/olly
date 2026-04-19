import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { Header } from "@/components/header";
import { StateMachine } from "@/components/state-machine";
import { EventStream } from "@/components/event-stream";
import { useIncidentStore } from "@/lib/incident-store";
import { useAgentSocket, getAgentHttpBase } from "@/lib/ws";
import { replayMockStream, type MockScenario } from "@/lib/mock-stream";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const [mockActive, setMockActive] = useState(false);
  const { store, ingest, reset } = useIncidentStore(mockActive);
  const [triggering, setTriggering] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  // Live WS is disabled while mock replay is running so the two streams do
  // not fight each other.
  const ws = useAgentSocket(ingest, !mockActive);

  const onReplay = useCallback(
    (scenario: MockScenario) => {
      if (cancelRef.current) cancelRef.current();
      reset();
      setMockActive(true);
      cancelRef.current = replayMockStream(ingest, scenario);
    },
    [ingest, reset],
  );

  const onTriggerDemo = useCallback(async () => {
    if (triggering) return;
    setTriggering(true);
    const base = getAgentHttpBase();
    const payload = {
      workspace: "default",
      events: [
        {
          signature: `website|TypeError|dashboard_${Date.now()}`,
          service: "website",
          level: "error",
          message: "Cannot read properties of undefined (reading amount)",
          stackTrace:
            "TypeError: Cannot read properties of undefined (reading amount)\n    at computeTotal (/src/lib/price.ts:5:12)",
          statusCode: 500,
          route: "/boom",
          traceId: `dash-${Date.now()}`,
          timestamp: new Date().toISOString(),
          deployId: "dashboard",
          errorClass: "TypeError",
          signatureSource: "stack",
        },
      ],
    };
    const res = await fetch(`${base}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      console.error("trigger failed", err);
      return null;
    });
    if (!res || !res.ok) {
      console.error("signal rejected", res?.status);
    }
    setTriggering(false);
  }, [triggering]);

  // Auto-clear the mock flag once the scripted timeline is exhausted. We use
  // the `incident_resolved` event as the terminal marker.
  useEffect(() => {
    if (!mockActive) return;
    const last = store.entries[store.entries.length - 1];
    if (last && last.kind === "incident_resolved") {
      const t = setTimeout(() => setMockActive(false), 1_500);
      return () => clearTimeout(t);
    }
  }, [mockActive, store.entries]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) cancelRef.current();
    };
  }, []);

  const incidentActive =
    store.state !== "IDLE" &&
    !store.banner?.resolved &&
    !store.banner?.outOfScope;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header
        wsStatus={ws.status}
        latencyMs={ws.latencyMs}
        reconnectInMs={ws.reconnectInMs}
        mockActive={mockActive}
        triggering={triggering}
        onReplay={onReplay}
        onTriggerDemo={onTriggerDemo}
      />

      <main className="grid flex-1 grid-cols-[45%_1fr] overflow-hidden">
        <section className="border-r border-border bg-card/20">
          <StateMachine
            current={store.state}
            stateEnteredAtMs={store.stateEnteredAtMs}
            outOfScope={!!store.banner?.outOfScope}
            incidentActive={incidentActive}
          />
        </section>
        <section className="min-w-0 overflow-hidden">
          <EventStream entries={store.entries} banner={store.banner} />
        </section>
      </main>
    </div>
  );
}
