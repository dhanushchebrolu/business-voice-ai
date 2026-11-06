/**
 * Reproducible LiveKit SIP configuration for ClickAI (infrastructure as code
 * over livekit-server-sdk 2.19.2's SipClient). DRY RUN by default: prints
 * the plan and the current state; changes nothing unless --apply is given.
 *
 *   node --experimental-strip-types deploy/livekit/provision-sip.ts            # plan
 *   node --experimental-strip-types deploy/livekit/provision-sip.ts --apply    # apply + verify
 *   ... --apply --with-outbound   # also create the outbound trunk (outbound must be approved)
 *
 * Exit codes: 0 = plan printed / applied and verified; 1 = invalid
 * configuration, ambiguous LiveKit state, API failure (the steps already
 * applied are printed; re-running converges) or read-back mismatch.
 * Implementation and tests: deploy/livekit/sip-provisioning.ts,
 * tests/sip-provisioning.spec.ts (real SipClient, stubbed transport).
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
 *   outbound trunk "clickai-vobiz-outbound"  ONLY with --with-outbound AND
 *       VOBIZ_OUTBOUND_SIP_DOMAIN (digest credentials from VOBIZ_OUTBOUND_*);
 *       created once, never updated or deleted by this script
 *
 * The Vobiz side (inbound trunk whose Primary URI is this LiveKit project's
 * SIP host, and linking each number) is done in the Vobiz console/API per
 * RUNBOOK.md; this script never touches Vobiz.
 */
import { SipClient } from "livekit-server-sdk";
import { ProvisionError, provisionSip, type DesiredSip } from "./sip-provisioning.ts";

const env = (n: string) => process.env[n]?.trim() || undefined;
const list = (n: string) =>
  (env(n) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

async function main() {
  const apply = process.argv.includes("--apply");
  const withOutbound = process.argv.includes("--with-outbound");
  const url = env("LIVEKIT_URL");
  const key = env("LIVEKIT_API_KEY");
  const secret = env("LIVEKIT_API_SECRET");
  const appEnv = env("APP_ENV") ?? "development";
  if (!url || !key || !secret)
    throw new ProvisionError("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required");
  const domain = env("VOBIZ_OUTBOUND_SIP_DOMAIN");
  if (domain && !withOutbound)
    console.warn(
      "VOBIZ_OUTBOUND_SIP_DOMAIN is set but --with-outbound was not given: no outbound trunk is created",
    );
  const desired: DesiredSip = {
    inboundNumbers: list("SIP_INBOUND_NUMBERS"),
    allowedAddresses: list("VOBIZ_SIP_SIGNALING_IPS"),
    agentName: env("AGENT_NAME") ?? "clickai-receptionist",
    outbound:
      withOutbound && domain
        ? {
            domain,
            ...(env("VOBIZ_OUTBOUND_SIP_USERNAME")
              ? { username: env("VOBIZ_OUTBOUND_SIP_USERNAME")! }
              : {}),
            ...(env("VOBIZ_OUTBOUND_SIP_PASSWORD")
              ? { password: env("VOBIZ_OUTBOUND_SIP_PASSWORD")! }
              : {}),
          }
        : null,
  };
  if (withOutbound && !domain)
    throw new ProvisionError("--with-outbound needs VOBIZ_OUTBOUND_SIP_DOMAIN");
  const sip = new SipClient(url.replace(/^wss?:/, "https:"), key, secret);
  const { plan, applied } = await provisionSip(sip, desired, { apply, appEnv });
  // Never prints credentials: only names, counts, numbers and the plan.
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "plan (dry run: nothing changed)",
        appEnv,
        desired: {
          inboundNumbers: desired.inboundNumbers,
          allowedAddresses: desired.allowedAddresses.length,
          agentName: desired.agentName,
          outbound: desired.outbound ? desired.outbound.domain : null,
        },
        plan,
        ...(apply ? { applied, verified: true } : {}),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(
    e instanceof ProvisionError ? e.message : `provisioning failed: ${(e as Error).message}`,
  );
  if (e instanceof ProvisionError && e.applied.length)
    console.error(`already applied: ${e.applied.join(", ")}`);
  process.exit(1);
});
