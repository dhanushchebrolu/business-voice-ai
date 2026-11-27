/**
 * Local browser harness only (never built into the app): in-memory stand-ins
 * for the server functions OutboundAgentPanel and AgentRecovery call, swapped in by
 * dev-harness/provisioning/vite.config.ts. They follow the real contracts and
 * refusal messages, so the REAL panel can be exercised with no database,
 * provider or secrets. Every call is recorded on window.__harness.
 */
type Role = "inbound" | "outbound";

export const harness = {
  calls: [] as { fn: string; data: unknown }[],
  /** Agent ids the "database" refuses, with the real server message. */
  refuse: {
    "A-in-1":
      "That is this customer's inbound agent. The outbound agent must be a separate Sarvam agent.",
    "B-out-1": "That Sarvam agent is already another customer's outbound agent.",
  } as Record<string, string>,
};
(window as unknown as { __harness: typeof harness }).__harness = harness;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function issueSarvamIntegrationCredential({
  data,
}: {
  data: { orgId: string; reason: string; role?: Role };
}) {
  harness.calls.push({ fn: "issue", data });
  await wait(150);
  return {
    token: "cai_sv_HARNESS-ONLY-not-a-real-credential-0000000000",
    tokenPrefix: "cai_sv_HARN",
    rotated: false,
    expiresAt: null,
    role: data.role ?? "inbound",
  };
}

export async function disableSarvamIntegration({
  data,
}: {
  data: { orgId: string; reason: string; role?: Role };
}) {
  harness.calls.push({ fn: "disable", data });
  return { ok: true as const };
}

export async function releaseSarvamAgentId({
  data,
}: {
  data: { orgId: string; sarvamAppId: string; reason: string };
}) {
  harness.calls.push({ fn: "release", data });
  await wait(150);
  const refused = harness.refuse[data.sarvamAppId];
  if (refused) throw new Error("That agent is registered for this customer.");
  return { released: 1, tokensRevoked: 1, jobState: "waiting_for_outbound_agent" };
}

export async function confirmOutboundToolAuth({
  data,
}: {
  data: { orgId: string; agentRef: string; everyToolChecked: boolean; reason: string };
}) {
  harness.calls.push({ fn: "confirmTools", data });
  await wait(150);
  if (data.agentRef !== "outbound:agent_demo")
    throw new Error("Every tool must send agent_ref = outbound:agent_demo.");
  return { confirmed: true as const, jobResumed: false };
}

export async function registerCustomerSarvamOutboundAgent({
  data,
}: {
  data: { orgId: string; sarvamAppId: string; sarvamAppVersion: number; reason: string };
}) {
  harness.calls.push({ fn: "registerOutbound", data });
  await wait(150);
  const refused = harness.refuse[data.sarvamAppId];
  if (refused) throw new Error(refused);
  return {
    ok: true as const,
    outboundConfirmationCleared: false,
    run: { state: "active", note: null },
  };
}
