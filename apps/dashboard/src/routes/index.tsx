import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { Header } from "@/components/header";
import { StateMachine } from "@/components/state-machine";
import { EventStream } from "@/components/event-stream";
import { StubModal } from "@/components/stub-modal";
import { useIncidentStore } from "@/lib/incident-store";
import { useAgentSocket } from "@/lib/ws";
import { replayMockStream, type MockScenario } from "@/lib/mock-stream";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

type StubKind = "trigger" | "install" | null;

function Dashboard() {
  const [mockActive, setMockActive] = useState(false);
  const { store, ingest, reset } = useIncidentStore(mockActive);
  const [stub, setStub] = useState<StubKind>(null);
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
        onReplay={onReplay}
        onTriggerDemo={() => setStub("trigger")}
        onInstallApp={() => setStub("install")}
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

      {stub === "trigger" && (
        <StubModal
          title="Trigger demo"
          body="The demo pipeline isn't wired to the dashboard yet. This button will plant the bug commit and let the agent pick it up once the backend is online."
          onClose={() => setStub(null)}
        />
      )}
      {stub === "install" && (
        <StubModal
          title="Install GitHub App"
          body="GitHub App install is a demo stub for the MVP. We authenticate via a fine-grained PAT on the server — there is no real install flow yet."
          onClose={() => setStub(null)}
        />
      )}
    </div>
  );
}
