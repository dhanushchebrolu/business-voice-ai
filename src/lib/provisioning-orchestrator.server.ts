import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { claimAvailablePhoneNumber } from "./phone-number-pool.server.ts";
import { createInboundDeploymentForNumbers } from "./sarvam-inbound-deployment.server.ts";

/**
 * Automatic provisioning orchestrator: what runs the instant a client's
 * setup payment clears (called from the Razorpay webhook's setup_fee
 * branch), and is re-runnable on demand from the admin provisioning view's
 * Retry action (Task #95) — same function either way, so there is exactly
 * one "what does automatic provisioning actually do" implementation.
 *
 * Honest scope, matching the audit this work started from: Sarvam
 * connection registration and agent-app creation are manual, one-time,
 * per-organization admin steps performed in Sarvam's own dashboard (no
 * public API exists for either — see sarvam-provider.server.ts's module
 * doc). This function does not invent one. What it DOES fully automate,
 * because it needs no Sarvam dashboard step at all:
 *
 *   1. Claiming a phone number from Klyro's own pool
 *      (phone-number-pool.server.ts) — idempotent: if this organization
 *      already holds a non-released number, that one is reused rather than
 *      claiming a second.
 *   2. Linking that number to the organization's existing Sarvam
 *      connection/agent mapping, if an admin has already set one up
 *      (before or after this payment) — a Klyro-internal database write,
 *      not a Sarvam call.
 *   3. If both a registered connection and a Sarvam-mapped agent are
 *      already in place, calling the same createInboundDeploymentForNumbers
 *      the admin UI uses to actually create the inbound deployment, then
 *      marking the number active + outbound-enabled once that genuinely
 *      succeeds.
 *
 * If the connection/agent mapping is not yet done, this claims and links
 * the number, advances lifecycle_status to "provisioning" (never further —
 * "ready"/"active" still requires handoverClient's full readiness check,
 * including a workspace member having actually joined and an agent version
 * having actually been published, neither of which this function can
 * manufacture), and records exactly what is still missing in
 * organizations.provisioning_note rather than claiming success.
 *
 * Never throws: a Sarvam outage or a missing prerequisite must not fail
 * the payment webhook that calls this (the payment itself is already
 * recorded by the time this runs) — every failure is caught and folded
 * into the returned note instead.
 */

export interface ProvisionOrganizationResult {
  organizationId: string;
  phoneNumberId: string | null;
  numberClaimedNow: boolean;
  deploymentCreatedNow: boolean;
  note: string;
}

export async function provisionOrganizationAfterPayment(
  supabaseAdmin: SupabaseClient<Database>,
  organizationId: string,
): Promise<ProvisionOrganizationResult> {
  const notes: string[] = [];
  let numberClaimedNow = false;
  let deploymentCreatedNow = false;

  try {
    const { data: org } = await supabaseAdmin
      .from("organizations")
      .select("id, lifecycle_status")
      .eq("id", organizationId)
      .maybeSingle();
    if (!org) {
      const note = "Organization not found — cannot provision.";
      return { organizationId, phoneNumberId: null, numberClaimedNow, deploymentCreatedNow, note };
    }

    // Only ever advance forward from setup_paid — never regress an
    // already-further-along (or not-yet-paid) organization, matching the
    // Razorpay webhook's own monotonic-advance rule for lifecycle_status.
    const nextLifecycleStatus =
      org.lifecycle_status === "setup_paid" ? ("provisioning" as const) : org.lifecycle_status;

    // Idempotency: reuse an already-assigned, non-released number for this
    // org (from a prior webhook retry, or an admin's manual assignment)
    // rather than claiming a second one from the pool.
    const { data: existingNumbers } = await supabaseAdmin
      .from("phone_numbers")
      .select("id, status, provider, connection_id, agent_config_id, provider_deployment_id")
      .eq("organization_id", organizationId)
      .neq("status", "released")
      .order("created_at", { ascending: true });

    let numberRow = existingNumbers?.[0] ?? null;

    if (!numberRow) {
      const claimed = await claimAvailablePhoneNumber(supabaseAdmin, {
        organizationId,
        provider: "sarvam",
      });
      if (claimed) {
        numberRow = claimed;
        numberClaimedNow = true;
        notes.push(`Claimed phone number ${claimed.e164} from the pool.`);
      } else {
        notes.push(
          "No phone number is currently available in the pool for provider 'sarvam' — an admin needs to import one.",
        );
      }
    } else {
      notes.push(`Reusing already-assigned phone number (status: ${numberRow.status}).`);
    }

    if (!numberRow) {
      await recordAttempt(supabaseAdmin, organizationId, nextLifecycleStatus, notes.join(" "));
      return {
        organizationId,
        phoneNumberId: null,
        numberClaimedNow,
        deploymentCreatedNow,
        note: notes.join(" "),
      };
    }

    // Link the org's existing Sarvam connection/agent mapping onto this
    // number, if either is missing on the row and already exists for this
    // org — purely a Klyro-internal write, never a Sarvam call.
    const { data: connection } = await supabaseAdmin
      .from("telephony_connections")
      .select("id, provider, provider_connection_id")
      .eq("organization_id", organizationId)
      .eq("provider", "sarvam")
      .maybeSingle();
    const { data: agentConfig } = await supabaseAdmin
      .from("agent_configs")
      .select("id, sarvam_app_id, sarvam_app_version")
      .eq("organization_id", organizationId)
      .maybeSingle();

    const linkUpdate: { connection_id?: string; agent_config_id?: string } = {};
    if (!numberRow.connection_id && connection) linkUpdate.connection_id = connection.id;
    if (!numberRow.agent_config_id && agentConfig) linkUpdate.agent_config_id = agentConfig.id;
    if (Object.keys(linkUpdate).length > 0) {
      const { error: linkError } = await supabaseAdmin
        .from("phone_numbers")
        .update(linkUpdate)
        .eq("id", numberRow.id);
      if (linkError) throw linkError;
      numberRow = { ...numberRow, ...linkUpdate };
    }

    const connectionReady = Boolean(connection?.provider_connection_id);
    const agentReady = Boolean(agentConfig?.sarvam_app_id && agentConfig.sarvam_app_version);

    if (!connectionReady) {
      notes.push(
        "This organization has no registered Sarvam connection yet — an admin must call registerTelephonyConnection before inbound deployment can be created.",
      );
    }
    if (!agentReady) {
      notes.push(
        "This organization's agent has not been mapped to a Sarvam app yet — an admin must call setSarvamAppMapping before inbound deployment can be created.",
      );
    }

    if (connectionReady && agentReady && !numberRow.provider_deployment_id) {
      try {
        const deployed = await createInboundDeploymentForNumbers(supabaseAdmin, {
          phoneNumberIds: [numberRow.id],
          name: `Klyro - ${organizationId} inbound`,
        });
        deploymentCreatedNow = true;
        notes.push(`Created Sarvam inbound deployment ${deployed.deploymentId}.`);

        const { error: activateError } = await supabaseAdmin
          .from("phone_numbers")
          .update({ status: "active", inbound_enabled: true, outbound_enabled: true })
          .eq("id", numberRow.id)
          .eq("status", numberRow.status); // no-op if something else already moved it
        if (activateError) throw activateError;
        notes.push("Phone number is now active with inbound and outbound enabled.");
      } catch (err) {
        notes.push(
          `Automatic inbound deployment creation failed: ${(err as Error).message}. Retry from the admin provisioning view once resolved.`,
        );
      }
    } else if (numberRow.provider_deployment_id) {
      notes.push("This number already has a Sarvam deployment on file — nothing to create.");
    }

    // Advance the onboarding lifecycle only as far as this function can
    // honestly claim: "provisioning" means payment is done and setup is
    // underway, never "ready"/"active" — those still require
    // handoverClient's full readiness check (workspace membership, a
    // published agent version), which no amount of automatic phone/
    // deployment work can satisfy on its own.
    await recordAttempt(supabaseAdmin, organizationId, nextLifecycleStatus, notes.join(" "));

    return {
      organizationId,
      phoneNumberId: numberRow.id,
      numberClaimedNow,
      deploymentCreatedNow,
      note: notes.join(" "),
    };
  } catch (err) {
    const note = `Automatic provisioning failed unexpectedly: ${(err as Error).message}`;
    console.error("provisioning_orchestrator:unexpected_error", organizationId, note);
    try {
      await supabaseAdmin
        .from("organizations")
        .update({ provisioning_note: note, provisioning_attempted_at: new Date().toISOString() })
        .eq("id", organizationId);
    } catch {
      // Best-effort only — the caller (Razorpay webhook) must never fail
      // because this side-channel status write also failed.
    }
    return { organizationId, phoneNumberId: null, numberClaimedNow, deploymentCreatedNow, note };
  }
}

async function recordAttempt(
  supabaseAdmin: SupabaseClient<Database>,
  organizationId: string,
  lifecycleStatus: Database["public"]["Enums"]["lifecycle_status"],
  note: string,
): Promise<void> {
  await supabaseAdmin
    .from("organizations")
    .update({
      lifecycle_status: lifecycleStatus,
      provisioning_note: note,
      provisioning_attempted_at: new Date().toISOString(),
    })
    .eq("id", organizationId);
}
