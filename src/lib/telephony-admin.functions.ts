import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";
import { getTelephonyAdapter, providerStatus, TELEPHONY_PROVIDERS } from "@/lib/telephony.server";

/**
 * Admin telephony control plane: phone-number lifecycle and the
 * cross-organization call list. Every mutation goes through
 * assertPlatformAdmin (capability "numbers.write", already defined before
 * Phase D) and is audited. Customers never reach these functions —
 * their own read-only views (numbersQuery/callsQuery in workspace.ts) go
 * straight to Supabase under RLS + the column-level grants added by the
 * Phase D migration.
 */

/* ------------------------------------------------------------------ */
/* Phone numbers                                                       */
/* ------------------------------------------------------------------ */

export const listTelephonyProviderDefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    return { providers: providerStatus(), definitions: TELEPHONY_PROVIDERS };
  });

export const listPhoneNumbers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { orgId?: string; status?: string; search?: string }) => input ?? {})
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let query = supabaseAdmin
      .from("phone_numbers")
      .select("*")
      .order("created_at", { ascending: false });
    if (data.orgId) query = query.eq("organization_id", data.orgId);
    if (data.status) query = query.eq("status", data.status);
    if (data.search) query = query.ilike("e164", `%${data.search}%`);
    const { data: numbers, error } = await query;
    if (error) throw error;

    const orgIds = [...new Set((numbers ?? []).map((n) => n.organization_id))];
    const { data: orgs } = orgIds.length
      ? await supabaseAdmin.from("organizations").select("id, client_id, name").in("id", orgIds)
      : { data: [] as { id: string; client_id: string; name: string }[] };
    const orgById = new Map((orgs ?? []).map((o) => [o.id, o]));

    return (numbers ?? []).map((n) => ({
      ...n,
      clientId: orgById.get(n.organization_id)?.client_id ?? "—",
      customerName: orgById.get(n.organization_id)?.name ?? "Unknown",
    }));
  });

interface ProvisionNumberInput {
  orgId: string;
  provider: string;
  purchase: boolean;
  country?: string;
  prefix?: string;
  /** required when purchase is false — a number already bought in the provider's own console */
  e164?: string;
  providerNumberId?: string;
  displayNumber?: string;
  reason: string;
}

/** Provisions a new number — either purchased through the provider adapter, or manually attached. */
export const provisionPhoneNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ProvisionNumberInput) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.provider) throw new Error("provider is required");
    if (!input.purchase && !input.e164)
      throw new Error("e164 is required when not purchasing through the provider");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: org } = await supabaseAdmin
      .from("organizations")
      .select("id, name")
      .eq("id", data.orgId)
      .maybeSingle();
    if (!org) throw new Error("Client not found");

    let e164 = data.e164 ?? "";
    let providerNumberId = data.providerNumberId ?? null;
    let displayNumber = data.displayNumber ?? data.e164 ?? "";
    let monthlyPrice: number | null = null;

    if (data.purchase) {
      const adapter = getTelephonyAdapter(data.provider);
      if (!adapter)
        throw new Error(`${data.provider} is not connected. Configure its credentials first.`);
      const provisioned = await adapter.provisionNumber({
        country: data.country ?? "IN",
        prefix: data.prefix,
      });
      e164 = provisioned.e164;
      providerNumberId = provisioned.providerNumberId;
      displayNumber = provisioned.displayNumber;
      monthlyPrice = provisioned.monthlyPrice;
    }

    const { data: row, error } = await supabaseAdmin
      .from("phone_numbers")
      .insert({
        organization_id: data.orgId,
        e164,
        display_number: displayNumber,
        country: data.country ?? "IN",
        provider: data.provider,
        provider_number_id: providerNumberId,
        status: "provisioning",
        inbound_enabled: false,
        outbound_enabled: false,
        monthly_price: monthlyPrice,
        purchased_at: new Date().toISOString(),
        provisioned_by: admin.userId,
      })
      .select("id")
      .single();
    if (error) throw error;

    await writeAudit(admin, {
      action: "NUMBER_PROVISIONED",
      entityType: "phone_number",
      entityId: row.id,
      organizationId: data.orgId,
      newValue: { e164, provider: data.provider, purchased: data.purchase },
      reason: data.reason,
    });
    return { id: row.id, e164 };
  });

/** Marks a provisioning number active and ready to receive traffic. */
export const activatePhoneNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { numberId: string; reason: string }) => {
    if (!input?.numberId) throw new Error("numberId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("phone_numbers")
      .select("status, organization_id, e164")
      .eq("id", data.numberId)
      .maybeSingle();
    if (!before) throw new Error("Number not found");
    if (before.status === "active") throw new Error("This number is already active");
    if (before.status === "released")
      throw new Error("A released number cannot be reactivated — provision a new one");

    const { error } = await supabaseAdmin
      .from("phone_numbers")
      .update({ status: "active", suspended_reason: null })
      .eq("id", data.numberId);
    if (error) {
      // Most likely the global "one active row per e164" uniqueness constraint.
      if ((error as { code?: string }).code === "23505") {
        throw new Error("This number is already active on another organization.");
      }
      throw error;
    }

    await writeAudit(admin, {
      action: "NUMBER_ASSIGNED",
      entityType: "phone_number",
      entityId: data.numberId,
      organizationId: before.organization_id,
      oldValue: before,
      newValue: { status: "active" },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/** Moves a number to a different organization. Always lands "provisioning" and inbound/outbound off, so a mis-routed call can never reach the wrong workspace. */
export const reassignPhoneNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { numberId: string; toOrgId: string; reason: string }) => {
    if (!input?.numberId || !input.toOrgId) throw new Error("numberId and toOrgId are required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("phone_numbers")
      .select("*")
      .eq("id", data.numberId)
      .maybeSingle();
    if (!before) throw new Error("Number not found");

    const { data: destOrg } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("id", data.toOrgId)
      .maybeSingle();
    if (!destOrg) throw new Error("Destination client not found");

    const { error } = await supabaseAdmin
      .from("phone_numbers")
      .update({
        organization_id: data.toOrgId,
        business_id: null,
        agent_config_id: null,
        status: "provisioning",
        inbound_enabled: false,
        outbound_enabled: false,
        suspended_reason: null,
      })
      .eq("id", data.numberId);
    if (error) throw error;

    await writeAudit(admin, {
      action: "NUMBER_REASSIGNED",
      entityType: "phone_number",
      entityId: data.numberId,
      organizationId: data.toOrgId,
      oldValue: { organization_id: before.organization_id, e164: before.e164 },
      newValue: { organization_id: data.toOrgId },
      reason: data.reason,
    });
    return { ok: true as const };
  });

export const suspendPhoneNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { numberId: string; reason: string }) => {
    if (!input?.numberId) throw new Error("numberId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("phone_numbers")
      .select("status, organization_id")
      .eq("id", data.numberId)
      .maybeSingle();
    if (!before) throw new Error("Number not found");

    const { error } = await supabaseAdmin
      .from("phone_numbers")
      .update({ status: "suspended", suspended_reason: data.reason })
      .eq("id", data.numberId);
    if (error) throw error;

    await writeAudit(admin, {
      action: "NUMBER_SUSPENDED",
      entityType: "phone_number",
      entityId: data.numberId,
      organizationId: before.organization_id,
      oldValue: before,
      newValue: { status: "suspended" },
      reason: data.reason,
    });
    return { ok: true as const };
  });

export const releasePhoneNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { numberId: string; reason: string }) => {
    if (!input?.numberId) throw new Error("numberId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("phone_numbers")
      .select("*")
      .eq("id", data.numberId)
      .maybeSingle();
    if (!before) throw new Error("Number not found");
    if (before.status === "released") throw new Error("This number is already released");

    if (before.provider_number_id) {
      const adapter = getTelephonyAdapter(before.provider);
      if (adapter) {
        try {
          await adapter.releaseNumber(before.provider_number_id);
        } catch (err) {
          console.error("telephony:release_provider_number_failed", (err as Error).message);
          // Continue: the platform-side release must not be blocked by a
          // provider-side error the admin can retry manually.
        }
      }
    }

    const { error } = await supabaseAdmin
      .from("phone_numbers")
      .update({
        status: "released",
        released_at: new Date().toISOString(),
        inbound_enabled: false,
        outbound_enabled: false,
      })
      .eq("id", data.numberId);
    if (error) throw error;

    await writeAudit(admin, {
      action: "NUMBER_RELEASED",
      entityType: "phone_number",
      entityId: data.numberId,
      organizationId: before.organization_id,
      oldValue: { status: before.status, e164: before.e164 },
      newValue: { status: "released" },
      reason: data.reason,
    });
    return { ok: true as const };
  });

export const setNumberDirection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      numberId: string;
      direction: "inbound" | "outbound";
      enabled: boolean;
      reason: string;
    }) => {
      if (!input?.numberId) throw new Error("numberId is required");
      if (input.direction !== "inbound" && input.direction !== "outbound")
        throw new Error("Invalid direction");
      if (!input.reason?.trim()) throw new Error("A reason is required");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("phone_numbers")
      .select("status, organization_id, inbound_enabled, outbound_enabled")
      .eq("id", data.numberId)
      .maybeSingle();
    if (!before) throw new Error("Number not found");
    if (data.enabled && before.status !== "active")
      throw new Error("Only an active number can have inbound/outbound enabled");

    const column = data.direction === "inbound" ? "inbound_enabled" : "outbound_enabled";
    const { error } = await supabaseAdmin
      .from("phone_numbers")
      .update({ [column]: data.enabled } as never)
      .eq("id", data.numberId);
    if (error) throw error;

    await writeAudit(admin, {
      action: data.direction === "inbound" ? "NUMBER_INBOUND_SET" : "NUMBER_OUTBOUND_SET",
      entityType: "phone_number",
      entityId: data.numberId,
      organizationId: before.organization_id,
      oldValue: { [column]: before[column] },
      newValue: { [column]: data.enabled },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* Calls (admin, platform-wide, with financials)                       */
/* ------------------------------------------------------------------ */

export interface AdminCallRow {
  id: string;
  organizationId: string;
  clientId: string;
  customerName: string;
  phoneNumberId: string | null;
  direction: string;
  callerNumber: string | null;
  destinationNumber: string | null;
  status: string;
  durationSeconds: number;
  customerCharge: number;
  providerCost: number;
  grossProfit: number;
  currency: string;
  startedAt: string;
  endedAt: string | null;
}

export const listAllCalls = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input?: { orgId?: string; status?: string; direction?: string; limit?: number }) =>
      input ?? {},
  )
  .handler(async ({ data, context }): Promise<AdminCallRow[]> => {
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let query = supabaseAdmin
      .from("call_logs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(Math.min(data.limit ?? 300, 1000));
    if (data.orgId) query = query.eq("organization_id", data.orgId);
    if (data.status) query = query.eq("status", data.status);
    if (data.direction) query = query.eq("direction", data.direction);
    const { data: calls, error } = await query;
    if (error) throw error;

    const orgIds = [...new Set((calls ?? []).map((c) => c.organization_id))];
    const { data: orgs } = orgIds.length
      ? await supabaseAdmin.from("organizations").select("id, client_id, name").in("id", orgIds)
      : { data: [] as { id: string; client_id: string; name: string }[] };
    const orgById = new Map((orgs ?? []).map((o) => [o.id, o]));

    return (calls ?? []).map((c) => ({
      id: c.id,
      organizationId: c.organization_id,
      clientId: orgById.get(c.organization_id)?.client_id ?? "—",
      customerName: orgById.get(c.organization_id)?.name ?? "Unknown",
      phoneNumberId: c.phone_number_id,
      direction: c.direction,
      callerNumber: c.caller_number,
      destinationNumber: c.destination_number,
      status: c.status,
      durationSeconds: c.duration_seconds,
      customerCharge: c.customer_charge,
      providerCost: c.provider_cost,
      grossProfit: c.gross_profit ?? c.customer_charge - c.provider_cost,
      currency: c.currency,
      startedAt: c.started_at,
      endedAt: c.ended_at,
    }));
  });
