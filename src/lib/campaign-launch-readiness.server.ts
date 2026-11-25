import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { validateCampaignContext } from "./campaign-context.ts";
import { retrySettingsProblem } from "./campaign-outcome.ts";
import { campaignSpend } from "./campaign-results.ts";
import { callerNumberIneligibility } from "./campaign-wizard.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";
import { isOutboundReady } from "./sarvam-outbound-mode.server.ts";

/**
 * Every condition a campaign must meet before it may start (or resume), in one
 * place: launchCampaign enforces it, and the campaign page shows the same list
 * as a checklist. Nothing here dials or writes; the dispatcher and admission
 * (admit_campaign_outbound_call) re-check what can change after launch.
 */

export type LaunchCheckKey =
  | "kill_switch"
  | "emergency_stop"
  | "dispatch_available"
  | "provider"
  | "campaign_status"
  | "dispatch_mode"
  | "agent"
  | "instructions"
  | "retry_settings"
  | "caller_number"
  | "contacts"
  | "pilot_allowlist"
  | "wallet"
  | "budget";

export interface LaunchCheck {
  key: LaunchCheckKey;
  label: string;
  ok: boolean;
  /** Why it fails and what fixes it; absent when ok. */
  detail?: string;
}

export interface CampaignReadiness {
  campaignId: string;
  status: string;
  ready: boolean;
  checks: LaunchCheck[];
  callerNumber: { id: string; e164: string } | null;
  contacts: { due: number; optedOut: number; outsideAllowlist: number };
}

export interface ReadinessDeps {
  db: SupabaseClient<Database>;
  /** OUTBOUND_CALLING_DISABLED: the global kill switch. */
  killSwitchOn: () => boolean;
  /** CAMPAIGN_DISPATCH_ENABLED: the platform-wide master switch for the dispatcher. */
  dispatchEnabled: () => boolean;
  /** platform_settings 'outbound.calling_paused'; fails closed. */
  emergencyStopActive: () => Promise<boolean>;
  /** Sarvam adapter and the authenticated result webhook URL are configured. */
  providerReady: () => { ok: boolean; reason?: string };
  /** The pilot allowlist (SARVAM_OUTBOUND_TEST_ALLOWLIST). */
  isAllowlisted: (e164: string) => boolean;
  /** The single-call number gate (entitlement, lifecycle, active, outbound-enabled). */
  numberGate: (
    orgId: string,
    numberId: string,
  ) => Promise<{ allowed: boolean; reason?: string | undefined }>;
  /**
   * At least one minute at the outbound rate is affordable right now. Launch
   * uses the locking check (wallet_can_afford); the page's checklist a plain read.
   */
  walletCanAfford: (orgId: string) => Promise<boolean>;
  /** What the customer pays per outbound minute (paise): the rate admission reserves a call at. */
  outboundRatePerMinute: (orgId: string) => Promise<number>;
}

const LAUNCHABLE = ["draft", "scheduled", "paused"];

/** Paise as the rupee amount customers see. */
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

/** "view" (the checklist) never locks; "launch" uses the locking wallet check. */
export async function defaultReadinessDeps(purpose: "view" | "launch"): Promise<ReadinessDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const eligibility = await import("./outbound-eligibility.server.ts");
  const { campaignDispatchEnabled } = await import("./jobs/handlers.server.ts");
  const {
    checkTelephonyAccess,
    walletCanAffordOutbound,
    walletBalanceCoversOutbound,
    getCallRate,
  } = await import("./telephony-guard.server.ts");
  const { getTelephonyAdapter, sarvamOutboundWebhookUrl } = await import("./telephony.server.ts");
  const { SarvamTelephonyAdapter } = await import("./telephony/sarvam-provider.server.ts");
  return {
    db: supabaseAdmin,
    killSwitchOn: eligibility.outboundCallingDisabled,
    dispatchEnabled: campaignDispatchEnabled,
    emergencyStopActive: () => eligibility.outboundEmergencyStopActive(supabaseAdmin),
    providerReady: () => {
      if (!(getTelephonyAdapter("sarvam") instanceof SarvamTelephonyAdapter))
        return { ok: false, reason: "Sarvam is not configured on this platform." };
      const webhook = sarvamOutboundWebhookUrl();
      return webhook.ok ? { ok: true } : { ok: false, reason: "Call results cannot be received." };
    },
    isAllowlisted: eligibility.isOutboundDestinationAllowlisted,
    numberGate: async (orgId, numberId) => {
      const gate = await checkTelephonyAccess(orgId, numberId, "outbound");
      return { allowed: gate.allowed, reason: gate.reason ?? undefined };
    },
    walletCanAfford: (orgId) =>
      purpose === "launch" ? walletCanAffordOutbound(orgId) : walletBalanceCoversOutbound(orgId),
    outboundRatePerMinute: async (orgId) =>
      (await getCallRate(orgId, "outbound")).customerAmountPerMinute,
  };
}

/** Evaluates every launch condition for one campaign of `orgId`; null when it is not this organization's. */
export async function evaluateCampaignLaunchReadiness(
  deps: ReadinessDeps,
  orgId: string,
  campaignId: string,
): Promise<CampaignReadiness | null> {
  const { db } = deps;
  const { data: campaign, error } = await db
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign || campaign.organization_id !== orgId) return null;

  const checks: LaunchCheck[] = [];
  const add = (key: LaunchCheckKey, label: string, problem: string | null | false | undefined) =>
    checks.push(problem ? { key, label, ok: false, detail: problem } : { key, label, ok: true });

  // Platform: nothing starts while any platform switch says stop.
  add(
    "kill_switch",
    "Outbound calling is on for the platform",
    deps.killSwitchOn() && "Outbound calling is switched off for the whole platform.",
  );
  const stopped = await deps.emergencyStopActive();
  add(
    "emergency_stop",
    "No emergency stop",
    stopped && "ClickAI's emergency stop is engaged; no campaign can start until it is lifted.",
  );
  add(
    "dispatch_available",
    "Campaign calling is available",
    !deps.dispatchEnabled() &&
      "Campaign calling is not switched on for the platform yet. Your campaign is saved; no calls are placed.",
  );
  const provider = deps.providerReady();
  add(
    "provider",
    "Calling provider is configured",
    !provider.ok &&
      `${provider.reason ?? "The calling provider is not configured."} Contact ClickAI support.`,
  );

  // Campaign.
  add(
    "campaign_status",
    "Campaign can be started",
    !LAUNCHABLE.includes(campaign.status) && `The campaign is ${campaign.status}.`,
  );
  add(
    "dispatch_mode",
    "Calls go through ClickAI's safety checks",
    campaign.dispatch_mode === "sarvam_campaign" &&
      "Sarvam-paced campaigns are not available; switch this campaign to ClickAI dialling.",
  );
  const reviewed = campaign.context_reviewed_at ? validateCampaignContext(campaign.context) : null;
  add(
    "instructions",
    "Call instructions are reviewed",
    !reviewed?.ok && "Review and confirm what the AI should say on these calls.",
  );
  add("retry_settings", "Retry settings are valid", retrySettingsProblem(campaign));

  let agentProblem: string | null = null;
  // The longest one call can run: admission reserves this many minutes per call.
  let capMinutes: number | null = null;
  if (!campaign.agent_config_id) agentProblem = "Choose an AI voice agent.";
  else {
    const { data: agent } = await db
      .from("agent_configs")
      .select(
        "organization_id, sarvam_app_id, sarvam_outbound_app_id, sarvam_outbound_app_version, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version, sarvam_outbound_max_call_seconds",
      )
      .eq("id", campaign.agent_config_id)
      .maybeSingle();
    if (!agent || agent.organization_id !== orgId)
      agentProblem = "The chosen agent does not belong to this workspace.";
    else if (!isOutboundReady(agent))
      agentProblem = "The agent's outbound version has not been confirmed by ClickAI support yet.";
    else if (!agent.sarvam_outbound_max_call_seconds)
      agentProblem = "The agent's maximum call length has not been set by ClickAI support yet.";
    else capMinutes = Math.ceil(agent.sarvam_outbound_max_call_seconds / 60);
  }
  add("agent", "Outbound agent is ready", agentProblem);

  // Caller number.
  let callerNumber: CampaignReadiness["callerNumber"] = null;
  let numberProblem: string | null = null;
  if (!campaign.phone_number_id)
    numberProblem = "Choose a caller number in the campaign configuration.";
  else {
    const { data: number } = await db
      .from("phone_numbers")
      .select("id, e164, organization_id, status, provider, outbound_enabled, connection_id")
      .eq("id", campaign.phone_number_id)
      .maybeSingle();
    if (!number || number.organization_id !== orgId)
      numberProblem = "The saved caller number does not belong to this workspace.";
    else {
      callerNumber = { id: number.id, e164: number.e164 };
      numberProblem = callerNumberIneligibility(number);
      if (!numberProblem && !number.connection_id)
        numberProblem = "The caller number has no telephony connection. Contact ClickAI support.";
      if (!numberProblem) {
        const { data: connection } = await db
          .from("telephony_connections")
          .select("provider, provider_connection_id")
          .eq("id", number.connection_id!)
          .maybeSingle();
        if (!connection || connection.provider !== "sarvam" || !connection.provider_connection_id)
          numberProblem =
            "The caller number's Sarvam connection is not registered. Contact ClickAI support.";
      }
      if (!numberProblem) {
        const gate = await deps.numberGate(orgId, number.id);
        if (!gate.allowed) numberProblem = gate.reason ?? "This number cannot make outbound calls.";
      }
    }
  }
  add("caller_number", "Caller number can call out", numberProblem);

  // Contacts: someone must be due, and in the pilot every due contact must be on the test list,
  // so a campaign never sits forever on contacts the dispatcher may not dial.
  const { data: due, error: dueError } = await db
    .from("campaign_contacts")
    .select("id, contact_id, status")
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "retry_scheduled"]);
  if (dueError) throw dueError;
  const contactIds = (due ?? []).map((c) => c.contact_id as string);
  const { data: people } = contactIds.length
    ? await db.from("contacts").select("id, phone, opted_out").in("id", contactIds)
    : { data: [] as { id: string; phone: string; opted_out: boolean }[] };
  let optedOut = 0;
  let outsideAllowlist = 0;
  let dialable = 0;
  for (const p of people ?? []) {
    if (p.opted_out) {
      optedOut++;
      continue;
    }
    dialable++;
    const e164 = normalizeCustomerPhone(p.phone, null);
    if (!e164 || !deps.isAllowlisted(e164)) outsideAllowlist++;
  }
  add(
    "contacts",
    "There are contacts to call",
    dialable === 0 &&
      (optedOut > 0
        ? "Every contact still to call has opted out."
        : "Add at least one contact before launching."),
  );
  add(
    "pilot_allowlist",
    "Every contact is on the pilot test list",
    outsideAllowlist > 0 &&
      `${outsideAllowlist} of ${dialable} contacts ${outsideAllowlist === 1 ? "is" : "are"} not on ClickAI's pilot test list, so ${outsideAllowlist === 1 ? "it" : "they"} would never be called. Remove ${outsideAllowlist === 1 ? "it" : "them"}, or ask ClickAI support to approve the number${outsideAllowlist === 1 ? "" : "s"}.`,
  );

  // Money: one call must be affordable, and the campaign's own budget must not be spent.
  add(
    "wallet",
    "Wallet can pay for a call",
    !(await deps.walletCanAfford(orgId)) &&
      "Your wallet balance is too low for a call. Add credit.",
  );
  let budgetProblem: string | null = null;
  if (campaign.budget_limit !== null && campaign.budget_limit !== undefined) {
    const { data: calls } = await db
      .from("call_logs")
      .select(
        "status, customer_charge, billing_applied_at, billing_cap_minutes, billing_rate_per_minute, resolution_source",
      )
      .eq("campaign_id", campaignId)
      .eq("organization_id", orgId);
    const spend = campaignSpend(calls ?? []);
    const committed = spend.spent + spend.reserved;
    if (committed >= campaign.budget_limit)
      budgetProblem = "This campaign's budget is used up. Raise the budget to continue.";
    else if (capMinutes !== null) {
      // The rule admission applies to every call: what is committed plus the most this
      // call can cost must fit. Checked here too, so a budget that can never pay for a
      // call is caught at launch instead of pausing the campaign when it first dials.
      const worstCase = capMinutes * (await deps.outboundRatePerMinute(orgId));
      if (committed + worstCase > campaign.budget_limit)
        budgetProblem = `The budget (${rupees(campaign.budget_limit)}) cannot cover the most one call can cost (${rupees(worstCase)}: up to ${capMinutes} ${capMinutes === 1 ? "minute" : "minutes"} per call). Raise the budget to at least ${rupees(committed + worstCase)}.`;
    }
  }
  add("budget", "Campaign budget remains", budgetProblem);

  return {
    campaignId,
    status: campaign.status,
    ready: checks.every((c) => c.ok),
    checks,
    callerNumber,
    contacts: { due: dialable, optedOut, outsideAllowlist },
  };
}
