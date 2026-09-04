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
    (input: {
      key: string;
      label?: string;
      unit?: string;
      customerAmount: number;
      providerCost: number;
      reason: string;
    }) => {
      if (!input?.key) throw new Error("key is required");
      if (!Number.isFinite(input.customerAmount) || input.customerAmount < 0)
        throw new Error("Invalid customer price");
      if (!Number.isFinite(input.providerCost) || input.providerCost < 0)
        throw new Error("Invalid provider cost");
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
    (input: {
      orgId: string;
      key: string;
      customerAmount: number | null;
      providerCost: number | null;
      reason: string;
    }) => {
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

/* ------------------------------------------------------------------ */
/* Billing transaction table (admin)                                   */
/* ------------------------------------------------------------------ */

export interface BillingTransactionRow {
  id: string;
  organizationId: string;
  clientId: string;
  customerName: string;
  purpose: string;
  provider: string;
  providerPaymentId: string | null;
  amount: number;
  currency: string;
  status: string;
  method: string | null;
  capturedAt: string | null;
  createdAt: string;
  invoiceNumber: string | null;
  refundedAmount: number;
  refundStatus: "none" | "partial" | "full" | "pending";
}

/**
 * Every captured/failed payment, joined with its invoice and any refunds,
 * for the admin billing screen. Filtering (customer/date/status/provider)
 * happens client-side over this list — the dataset is small enough
 * (platform-scale payments, not usage events) that a second server round
 * trip per filter isn't worth the complexity yet.
 */
export const listBillingTransactions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [paymentsRes, orgsRes, invoicesRes, refundsRes] = await Promise.all([
      supabaseAdmin
        .from("payments")
        .select(
          "id, organization_id, provider, provider_payment_id, purpose, amount, currency, status, method, captured_at, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(500),
      supabaseAdmin.from("organizations").select("id, client_id, name"),
      supabaseAdmin.from("invoices").select("payment_id, number"),
      supabaseAdmin.from("refunds").select("payment_id, amount, status"),
    ]);
    if (paymentsRes.error) throw paymentsRes.error;

    const orgById = new Map((orgsRes.data ?? []).map((o) => [o.id, o]));
    const invoiceByPayment = new Map((invoicesRes.data ?? []).map((i) => [i.payment_id, i.number]));
    const refundsByPayment = new Map<string, { amount: number; status: string }[]>();
    for (const r of refundsRes.data ?? []) {
      const list = refundsByPayment.get(r.payment_id) ?? [];
      list.push({ amount: r.amount, status: r.status });
      refundsByPayment.set(r.payment_id, list);
    }

    const rows: BillingTransactionRow[] = (paymentsRes.data ?? []).map((p) => {
      const org = orgById.get(p.organization_id);
      const refunds = refundsByPayment.get(p.id) ?? [];
      const processedAmount = refunds
        .filter((r) => r.status === "processed")
        .reduce((s, r) => s + r.amount, 0);
      const hasPending = refunds.some((r) => r.status === "pending");
      let refundStatus: BillingTransactionRow["refundStatus"] = "none";
      if (hasPending) refundStatus = "pending";
      else if (processedAmount > 0 && processedAmount >= p.amount) refundStatus = "full";
      else if (processedAmount > 0) refundStatus = "partial";

      return {
        id: p.id,
        organizationId: p.organization_id,
        clientId: org?.client_id ?? "—",
        customerName: org?.name ?? "Unknown",
        purpose: p.purpose,
        provider: p.provider,
        providerPaymentId: p.provider_payment_id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        method: p.method,
        capturedAt: p.captured_at,
        createdAt: p.created_at,
        invoiceNumber: invoiceByPayment.get(p.id) ?? null,
        refundedAmount: processedAmount,
        refundStatus,
      };
    });

    return rows;
  });

/* ------------------------------------------------------------------ */
/* Wallets (admin, platform-wide view)                                 */
/* ------------------------------------------------------------------ */

export interface WalletSummaryRow {
  organizationId: string;
  clientId: string;
  customerName: string;
  balance: number;
  lastActivityAt: string | null;
}

export const listWallets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [orgsRes, walletRes] = await Promise.all([
      supabaseAdmin.from("organizations").select("id, client_id, name").order("name"),
      supabaseAdmin.from("wallet_transactions").select("organization_id, amount, created_at"),
    ]);
    if (orgsRes.error) throw orgsRes.error;

    const byOrg = new Map<string, { balance: number; lastActivityAt: string | null }>();
    for (const tx of walletRes.data ?? []) {
      const cur = byOrg.get(tx.organization_id) ?? { balance: 0, lastActivityAt: null };
      cur.balance += tx.amount;
      if (!cur.lastActivityAt || tx.created_at > cur.lastActivityAt)
        cur.lastActivityAt = tx.created_at;
      byOrg.set(tx.organization_id, cur);
    }

    const rows: WalletSummaryRow[] = (orgsRes.data ?? []).map((org) => {
      const w = byOrg.get(org.id) ?? { balance: 0, lastActivityAt: null };
      return { organizationId: org.id, clientId: org.client_id, customerName: org.name, ...w };
    });

    return rows.sort((a, b) => b.balance - a.balance);
  });

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

/**
 * Requests a refund against a captured payment. Calls Razorpay server-side
 * and stores exactly the status Razorpay returns — never assumes success.
 * Enforces that the sum of processed + pending refunds for a payment never
 * exceeds the original amount (supports partial refunds, blocks
 * over-refunding). All refunds are audited.
 */
export const requestRefund = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { paymentId: string; amount: number; reason: string }) => {
    if (!input?.paymentId) throw new Error("paymentId is required");
    if (!Number.isFinite(input.amount) || input.amount <= 0)
      throw new Error("Invalid refund amount");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "billing.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: payment } = await supabaseAdmin
      .from("payments")
      .select("id, organization_id, provider_payment_id, amount, currency, status")
      .eq("id", data.paymentId)
      .maybeSingle();
    if (!payment) throw new Error("Payment not found");
    if (payment.status !== "captured") throw new Error("Only captured payments can be refunded");
    if (!payment.provider_payment_id)
      throw new Error("Payment has no provider reference to refund against");

    const { data: existingRefunds } = await supabaseAdmin
      .from("refunds")
      .select("amount, status")
      .eq("payment_id", data.paymentId)
      .in("status", ["processed", "pending"]);
    const alreadyRefunded = (existingRefunds ?? []).reduce((s, r) => s + r.amount, 0);
    const remaining = payment.amount - alreadyRefunded;
    if (data.amount > remaining) {
      throw new Error(
        `Refund amount exceeds what's left to refund (₹${(remaining / 100).toFixed(2)} remaining)`,
      );
    }

    const { createRazorpayRefund } = await import("@/lib/razorpay.server");
    const idempotencyKey = `refund_${data.paymentId}_${Date.now()}`;
    let providerRefund;
    try {
      providerRefund = await createRazorpayRefund({
        paymentId: payment.provider_payment_id,
        amount: data.amount,
        notes: { reason: data.reason, admin_email: admin.email ?? "" },
        idempotencyKey,
      });
    } catch (err) {
      await writeAudit(admin, {
        action: "REFUND_FAILED",
        entityType: "payment",
        entityId: data.paymentId,
        organizationId: payment.organization_id,
        reason: `${data.reason} — provider error: ${(err as Error).message}`,
      });
      throw err;
    }

    // Status comes straight from Razorpay's response — "processed" for
    // instant methods, "pending" otherwise. Never upgraded to "processed"
    // here; only the refund.processed webhook event does that.
    const status = providerRefund.status === "processed" ? "processed" : "pending";

    const { error } = await supabaseAdmin.from("refunds").insert({
      organization_id: payment.organization_id,
      payment_id: data.paymentId,
      provider: "razorpay",
      provider_refund_id: providerRefund.id,
      amount: data.amount,
      currency: payment.currency,
      status,
      reason: data.reason,
      requested_by: admin.userId,
      requested_by_email: admin.email,
      processed_at: status === "processed" ? new Date().toISOString() : null,
    });
    if (error) throw error;

    await writeAudit(admin, {
      action: "REFUND_REQUESTED",
      entityType: "payment",
      entityId: data.paymentId,
      organizationId: payment.organization_id,
      newValue: { amount: data.amount, status, provider_refund_id: providerRefund.id },
      reason: data.reason,
    });
    return { ok: true as const, status };
  });

export const listRefunds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [refundsRes, orgsRes] = await Promise.all([
      supabaseAdmin
        .from("refunds")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(300),
      supabaseAdmin.from("organizations").select("id, client_id, name"),
    ]);
    if (refundsRes.error) throw refundsRes.error;

    const orgById = new Map((orgsRes.data ?? []).map((o) => [o.id, o]));
    return (refundsRes.data ?? []).map((r) => ({
      ...r,
      clientId: orgById.get(r.organization_id)?.client_id ?? "—",
      customerName: orgById.get(r.organization_id)?.name ?? "Unknown",
    }));
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
      supabaseAdmin
        .from("usage_records")
        .select("organization_id, billable_cost, provider_cost, kind"),
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
      {
        payments: 0,
        walletCredits: 0,
        walletBalance: 0,
        revenue: 0,
        providerCost: 0,
        grossProfit: 0,
      },
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
