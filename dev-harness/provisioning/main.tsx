/**
 * Local browser harness for the admin Outbound agent panel (see fake-functions.ts).
 * Renders the real OutboundAgentPanel and the real outbound checklist with the
 * real gate and template builders. Scenario from ?scenario=:
 *   new (default)   no outbound credential, nothing registered
 *   credential      outbound credential issued, agent not registered
 *   registered      agent registered, not confirmed for outbound
 *   wrong           the inbound agent was registered as the outbound one
 * Not part of the app build.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { Toaster } from "@/components/ui/sonner";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { OutboundAgentPanel } from "@/components/admin/OutboundAgentPanel";
import { outboundChecklist, type OutboundChecklistInput } from "@/lib/provisioning-view";
import { sarvamToolConfiguration } from "@/lib/sarvam-agent-api.server";
import { buildOutboundAgentConfig } from "@/lib/universal-agent-config";
import type { AgentSnapshot } from "@/lib/agent-instructions";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "new";
const now = new Date("2026-11-20T10:00:00Z");

const snapshot = {
  business: { name: "Demo Dental", business_type: "dental_clinic", country: "IN" },
  services: [],
  hours: [],
  faqs: [],
  agent: { capabilities: {}, transfer_number: null },
} as unknown as AgentSnapshot;
const config = buildOutboundAgentConfig(snapshot, {
  default_language: "English",
  allowed_languages: ["English", "Hindi"],
  auto_language_switch: true,
  sarvam_voice_internal_id: "01a0cf17-12bd-7de3-9df0-f607db604d52",
});

function Page() {
  const credential =
    scenario === "new"
      ? null
      : {
          status: "active",
          token_prefix: "cai_sv_Ab12",
          created_at: "2026-11-20T09:00:00Z",
          rotated_at: null,
          last_used_at: null,
          expires_at: null,
        };
  const registered = scenario === "registered" ? "A-out-1" : scenario === "wrong" ? "A-in-1" : null;
  const [gate] = useState<OutboundChecklistInput>({
    inboundAppId: "A-in-1",
    credential: credential ? { status: "active", expiresAt: null } : null,
    appId: registered,
    appVersion: registered ? 1 : null,
    readyAppId: null,
    readyVersion: null,
    masterAgentAppIds: [],
    blockers: [],
    voiceLanguageProblem: null,
    now,
  });
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <SectionCard title="Checklist (outbound steps)">
        <ol className="space-y-1.5 text-sm" data-testid="provisioning-checklist">
          {outboundChecklist(gate).map((c) => (
            <li key={c.step} className="flex flex-wrap items-baseline gap-2">
              <StatusPill
                tone={c.status === "done" ? "live" : c.status === "todo" ? "idle" : "error"}
              >
                {c.status}
              </StatusPill>
              <span className="font-medium">
                {c.step}. {c.label}
              </span>
              <span className="text-xs text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ol>
      </SectionCard>
      <OutboundAgentPanel
        orgId="org_demo"
        gate={gate}
        credential={credential}
        config={config}
        template={sarvamToolConfiguration("https://clickai.example", "outbound")}
        registeredAt={registered ? "2026-11-20T09:30:00Z" : null}
        onChanged={async () => undefined}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
    <Toaster position="top-right" />
  </StrictMode>,
);
