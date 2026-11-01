/**
 * Reproducible LiveKit SIP configuration for ClickAI (infrastructure as code
 * over livekit-server-sdk 2.19.2's SipClient). DRY RUN by default: prints
 * the plan and the current state; changes nothing unless --apply is given.
 *
 *   node --experimental-strip-types deploy/livekit/provision-sip.ts            # plan
 *   node --experimental-strip-types deploy/livekit/provision-sip.ts --apply    # apply
 *
 * What it maintains (idempotent: found by name, updated in place):
 *   inbound trunk  "clickai-vobiz-inbound"
 *       numbers           = SIP_INBOUND_NUMBERS (only migrated numbers; add one
 *                           number at a time — see RUNBOOK.md)
 *       allowedAddresses  = VOBIZ_SIP_SIGNALING_IPS (Vobiz's published SIP
 *                           signalling IPs; never 0.0.0.0/0 outside development)
 *   dispatch rule  "clickai-receptionist"
 *       individual room per call ("call-<random>"), explicit dispatch of
 *       AGENT_NAME, restricted to the inbound trunk
 *   outbound trunk "clickai-vobiz-outbound"  (only when VOBIZ_OUTBOUND_* set)
 *       address = VOBIZ_OUTBOUND_SIP_DOMAIN with digest credentials
 *
 * The Vobiz side (inbound trunk whose Primary URI is this LiveKit project's
 * SIP host, and linking each number) is done in the Vobiz console/API per
 * RUNBOOK.md; this script never touches Vobiz.
 */
import { RoomAgentDispatch, RoomConfiguration, SipClient } from "livekit-server-sdk";

const INBOUND = "clickai-vobiz-inbound";
const OUTBOUND = "clickai-vobiz-outbound";
const RULE = "clickai-receptionist";

const env = (n: string) => process.env[n]?.trim() || undefined;
const list = (n: string) =>
  (env(n) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const apply = process.argv.includes("--apply");

async function main() {
  const url = env("LIVEKIT_URL");
  const key = env("LIVEKIT_API_KEY");
  const secret = env("LIVEKIT_API_SECRET");
  const appEnv = env("APP_ENV") ?? "development";
  const agentName = env("AGENT_NAME") ?? "clickai-receptionist";
  if (!url || !key || !secret)
    throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required");
  const numbers = list("SIP_INBOUND_NUMBERS");
  const allowed = list("VOBIZ_SIP_SIGNALING_IPS");
  for (const n of numbers) if (!/^\+[1-9]\d{6,14}$/.test(n)) throw new Error(`not E.164: ${n}`);
  if (appEnv !== "development" && (allowed.length === 0 || allowed.includes("0.0.0.0/0"))) {
    throw new Error("VOBIZ_SIP_SIGNALING_IPS must list Vobiz's signalling IPs outside development");
  }
  const sip = new SipClient(url.replace(/^wss?:/, "https:"), key, secret);
  const inbound = (await sip.listSipInboundTrunk()).find((t) => t.name === INBOUND);
  const rule = (await sip.listSipDispatchRule()).find((r) => r.name === RULE);
  const outbound = (await sip.listSipOutboundTrunk()).find((t) => t.name === OUTBOUND);

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "plan",
        appEnv,
        current: {
          inbound: inbound?.numbers ?? null,
          rule: rule?.sipDispatchRuleId ?? null,
          outbound: outbound?.address ?? null,
        },
        desired: { inboundNumbers: numbers, allowedAddresses: allowed.length, agentName },
      },
      null,
      2,
    ),
  );
  if (!apply) return;

  let trunkId = inbound?.sipTrunkId;
  if (!inbound) {
    trunkId = (
      await sip.createSipInboundTrunk(INBOUND, numbers, {
        allowedAddresses: allowed,
        krispEnabled: true,
      })
    ).sipTrunkId;
  } else {
    await sip.updateSipInboundTrunkFields(inbound.sipTrunkId, {
      numbers,
      allowedAddresses: allowed,
    } as never);
  }
  const roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName })] });
  if (!rule) {
    await sip.createSipDispatchRule(
      { type: "individual", roomPrefix: "call-" },
      { name: RULE, trunkIds: [trunkId!], roomConfig },
    );
  } else {
    await sip.updateSipDispatchRuleFields(rule.sipDispatchRuleId, {
      trunkIds: [trunkId!],
      roomConfig,
    } as never);
  }
  const domain = env("VOBIZ_OUTBOUND_SIP_DOMAIN");
  if (domain && !outbound) {
    await sip.createSipOutboundTrunk(OUTBOUND, domain, [], {
      transport: 0 as never, // SIP_TRANSPORT_AUTO
      authUsername: env("VOBIZ_OUTBOUND_SIP_USERNAME"),
      authPassword: env("VOBIZ_OUTBOUND_SIP_PASSWORD"),
    });
  }
  console.log("applied");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
