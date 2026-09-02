import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";

/**
 * Finance control plane.
 *
 * Every commercial number lives in `pricing_rules` as a pair: what the customer
 * is charged and what the provider costs us. Margin is derived, never typed in.
 * Provider cost is admin-only and is never returned to a customer surface.
 */

export const listPricingRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("pricing_rules").select("*").order("key");
    if (error) throw error;
    return data;
  });

export const upsertPricingRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { key: string; label?: string; unit?: string; customerAmount: number; providerCost: number; reason: string }) => {
      if (!input?.key) throw new Error("key is required");
      if (!Number.isFinite(input.customerAmount) || input.customerAmount < 0) throw new Error("Invalid customer price");
      if (!Number.isFinite(input.providerCost) || input.providerCost < 0) throw new Error("Invalid provider cost");
      if (!input.reason?.trim()) throw new Error("A reason is required");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "pricing.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("pricing_rules")
      .select("customer_amount, provider_cost")
      .eq("key", data.key)
      .maybeSingle();

    const { error } = await supabaseAdmin.from("pricing_rules").upsert(
      {
        key: data.key,
        label: data.label ?? data.key,
        unit: data.unit ?? "unit",
        customer_amount: Math.round(data.customerAmount),
        provider_cost: Math.round(data.providerCost),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    if (error) throw error;

    await writeAudit(admin, {
      action: "CHANGE_PRICE",
      entityType: "pricing_rule",
      entityId: data.key,
      oldValue: before,
      newValue: { customer_amount: data.customerAmount, provider_cost: data.providerCost },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/** Per-customer price override. Affects only that organization. */
export const setPricingOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { orgId: string; key: string; customerAmount: number | null; providerCost: number | null; reason: string }) => {
      if (!input?.orgId || !input.key) throw new Error("orgId and key are required");
      if (!input.reason?.trim()) throw new Error("A reason is required");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "pricing.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("organization_pricing_overrides")
      .select("customer_amount, provider_cost")
      .eq("organization_id", data.orgId)
      .eq("key", data.key)
      .maybeSingle();

    if (data.customerAmount === null && data.providerCost === null) {
      await supabaseAdmin
        .from("organization_pricing_overrides")
        .delete()
        .eq("organization_id", data.orgId)
        .eq("key", data.key);
    } else {
      const { error } = await supabaseAdmin.from("organization_pricing_overrides").upsert(
        {
          organization_id: data.orgId,
          key: data.key,
          customer_amount: data.customerAmount === null ? null : Math.round(data.customerAmount),
          provider_cost: data.providerCost === null ? null : Math.round(data.providerCost),
          note: data.reason,
          updated_by: admin.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,key" },
      );
      if (error) throw error;
    }

    await writeAudit(admin, {
      action: "CHANGE_PRICE",
      entityType: "pricing_override",
      entityId: data.key,
      organizationId: data.orgId,
      oldValue: before,
      newValue: { customer_amount: data.customerAmount, provider_cost: data.providerCost },
      reason: data.reason,
    });
    return { ok: true as const };
  });

export const listPricingOverrides = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => input)
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("organization_pricing_overrides")
      .select("*")
      .eq("organization_id", data.orgId);
    if (error) throw error;
    return rows;
  });

export interface ProfitRow {
  orgId: string;
  clientId: string;
  name: string;
  payments: number;
  walletCredits: number;
  walletBalance: number;
  revenue: number;
  providerCost: number;
  grossProfit: number;
  marginPct: number | null;
}

/**
 * Profit analytics computed from real rows only:
 * revenue and provider cost come from `usage_records` (billable vs provider
 * cost captured at the time of usage) and captured `payments`.
 */
export const getProfitAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [orgsRes, paymentsRes, walletRes, usageRes] = await Promise.all([
      supabaseAdmin.from("organizations").select("id, client_id, name").order("created_at"),
      supabaseAdmin.from("payments").select("organization_id, amount, status, purpose"),
      supabaseAdmin.from("wallet_transactions").select("organization_id, amount, kind"),
      supabaseAdmin.from("usage_records").select("organization_id, billable_cost, provider_cost, kind"),
    ]);

    const rows: ProfitRow[] = (orgsRes.data ?? []).map((org) => {
      const payments = (paymentsRes.data ?? [])
        .filter((p) => p.organization_id === org.id && p.status === "captured")
        .reduce((s, p) => s + p.amount, 0);
      const walletTx = (walletRes.data ?? []).filter((w) => w.organization_id === org.id);
      const walletCredits = walletTx.filter((w) => w.amount > 0).reduce((s, w) => s + w.amount, 0);
      const walletBalance = walletTx.reduce((s, w) => s + w.amount, 0);
      const usage = (usageRes.data ?? []).filter((u) => u.organization_id === org.id);
      const revenue = usage.reduce((s, u) => s + Number(u.billable_cost ?? 0), 0);
      const providerCost = usage.reduce((s, u) => s + Number(u.provider_cost ?? 0), 0);
      const grossProfit = revenue - providerCost;
      return {
        orgId: org.id,
        clientId: org.client_id,
        name: org.name,
        payments,
        walletCredits,
        walletBalance,
        revenue,
        providerCost,
        grossProfit,
        marginPct: revenue > 0 ? (grossProfit / revenue) * 100 : null,
      };
    });

    const totals = rows.reduce(
      (acc, r) => ({
        payments: acc.payments + r.payments,
        walletCredits: acc.walletCredits + r.walletCredits,
        walletBalance: acc.walletBalance + r.walletBalance,
        revenue: acc.revenue + r.revenue,
        providerCost: acc.providerCost + r.providerCost,
        grossProfit: acc.grossProfit + r.grossProfit,
      }),
      { payments: 0, walletCredits: 0, walletBalance: 0, revenue: 0, providerCost: 0, grossProfit: 0 },
    );

    return {
      rows,
      totals: {
        ...totals,
        marginPct: totals.revenue > 0 ? (totals.grossProfit / totals.revenue) * 100 : null,
        unconsumedLiability: totals.walletBalance,
      },
    };
  });
