import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, capabilitiesFor, writeAudit, type PlatformRole } from "@/lib/platform-admin.server";
import type { Database } from "@/integrations/supabase/types";

type AccountStatus = Database["public"]["Enums"]["account_status"];

const ACCOUNT_STATUSES: AccountStatus[] = ["payment_required", "setup_in_progress", "active", "suspended", "cancelled"];

/** Who am I in the admin plane? Returns null for ordinary customers. */
export const getAdminSession = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("platform_admins")
      .select("user_id, email, name, role, is_active")
      .eq("user_id", context.userId)
      .maybeSingle();

    if (!data || !data.is_active) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { count } = await supabaseAdmin
        .from("platform_admins")
        .select("user_id", { count: "exact", head: true })
        .eq("is_active", true);
      return { admin: null, bootstrapAvailable: (count ?? 0) === 0 };
    }

    const role = data.role as PlatformRole;
    return {
      admin: {
        userId: data.user_id,
        email: data.email,
        name: data.name,
        role,
        capabilities: capabilitiesFor(role),
      },
      bootstrapAvailable: false,
    };
  });

/**
 * One-time bootstrap: the very first signed-in user can claim super admin
 * only while no active platform admin exists. After that this always fails.
 */
export const claimPlatformAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin
      .from("platform_admins")
      .select("user_id", { count: "exact", head: true })
      .eq("is_active", true);
    if ((count ?? 0) > 0) throw new Error("Platform administration is already configured");

    const email = (context.claims["email"] as string | undefined) ?? null;
    const { error } = await supabaseAdmin
      .from("platform_admins")
      .upsert({ user_id: context.userId, email, role: "super_admin", is_active: true }, { onConflict: "user_id" });
    if (error) throw error;

    await writeAudit(
      { userId: context.userId, email, name: null, role: "super_admin", capabilities: capabilitiesFor("super_admin") },
      { action: "platform_admin.bootstrap", entityType: "platform_admin", entityId: context.userId },
    );
    return { ok: true as const };
  });

/** Operational counters for the admin overview. All real records, no estimates. */
export const getAdminOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const countOrgs = async (status?: AccountStatus) => {
      let q = supabaseAdmin.from("organizations").select("id", { count: "exact", head: true });
      if (status) q = q.eq("account_status", status);
      const { count } = await q;
      return count ?? 0;
    };

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startOfMonth = new Date(Date.UTC(startOfDay.getUTCFullYear(), startOfDay.getUTCMonth(), 1));

    const [total, active, paymentRequired, suspended, setupInProgress] = await Promise.all([
      countOrgs(),
      countOrgs("active"),
      countOrgs("payment_required"),
      countOrgs("suspended"),
      countOrgs("setup_in_progress"),
    ]);

    const [numbersRes, agentsRes, callsTodayRes, paymentsRes, settingRes, walletRes] = await Promise.all([
      supabaseAdmin.from("phone_numbers").select("id, status"),
      supabaseAdmin.from("agent_configs").select("id, status"),
      supabaseAdmin.from("call_logs").select("id, direction, duration_seconds").gte("started_at", startOfDay.toISOString()),
      supabaseAdmin.from("payments").select("amount, status, purpose, captured_at, created_at"),
      supabaseAdmin.from("platform_settings").select("key, value").eq("key", "billing.payment_required").maybeSingle(),
      supabaseAdmin.from("wallet_transactions").select("organization_id, amount"),
    ]);

    const calls = callsTodayRes.data ?? [];
    const payments = paymentsRes.data ?? [];
    const captured = payments.filter((p) => p.status === "captured");
    const inWindow = (iso: string | null, from: Date) => Boolean(iso && new Date(iso) >= from);

    const wallets = new Map<string, number>();
    for (const tx of walletRes.data ?? []) {
      wallets.set(tx.organization_id, (wallets.get(tx.organization_id) ?? 0) + tx.amount);
    }

    return {
      customers: { total, active, paymentRequired, suspended, setupInProgress },
      numbers: {
        total: numbersRes.data?.length ?? 0,
        assigned: (numbersRes.data ?? []).filter((n) => n.status === "active").length,
      },
      agents: {
        total: agentsRes.data?.length ?? 0,
        live: (agentsRes.data ?? []).filter((a) => a.status === "ready" || a.status === "live").length,
      },
      callsToday: {
        total: calls.length,
        inbound: calls.filter((c) => c.direction === "inbound").length,
        outbound: calls.filter((c) => c.direction === "outbound").length,
        minutes: Math.round(calls.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / 60),
      },
      revenue: {
        today: captured.filter((p) => inWindow(p.captured_at ?? p.created_at, startOfDay)).reduce((s, p) => s + p.amount, 0),
        month: captured.filter((p) => inWindow(p.captured_at ?? p.created_at, startOfMonth)).reduce((s, p) => s + p.amount, 0),
        allTime: captured.reduce((s, p) => s + p.amount, 0),
        failed: payments.filter((p) => p.status === "failed").length,
      },
      wallets: {
        totalBalance: [...wallets.values()].reduce((s, v) => s + v, 0),
        negative: [...wallets.values()].filter((v) => v < 0).length,
      },
      paymentEnforcement: Boolean((settingRes.data?.value as { enabled?: boolean } | null)?.enabled ?? true),
    };
  });

export interface AdminCustomerRow {
  id: string;
  name: string;
  ownerEmail: string | null;
  ownerName: string | null;
  businessType: string | null;
  accountStatus: AccountStatus;
  plan: string | null;
  subscriptionStatus: string | null;
  phoneNumber: string | null;
  walletBalance: number;
  nextBillingAt: string | null;
  setupPaidAt: string | null;
  createdAt: string;
}

/** Cross-organization customer list. Platform admins only. */
export const listCustomers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminCustomerRow[]> => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [orgsRes, profilesRes, bizRes, subsRes, numbersRes, walletRes] = await Promise.all([
      supabaseAdmin.from("organizations").select("*").order("created_at", { ascending: false }),
      supabaseAdmin.from("profiles").select("id, full_name, email"),
      supabaseAdmin.from("businesses").select("organization_id, business_type"),
      supabaseAdmin.from("subscriptions").select("organization_id, plan, status"),
      supabaseAdmin.from("phone_numbers").select("organization_id, e164, status"),
      supabaseAdmin.from("wallet_transactions").select("organization_id, amount"),
    ]);

    const profiles = new Map((profilesRes.data ?? []).map((p) => [p.id, p]));
    const biz = new Map((bizRes.data ?? []).map((b) => [b.organization_id, b.business_type]));
    const subs = new Map((subsRes.data ?? []).map((s) => [s.organization_id, s]));
    const numbers = new Map((numbersRes.data ?? []).map((n) => [n.organization_id, n.e164]));
    const wallets = new Map<string, number>();
    for (const tx of walletRes.data ?? []) {
      wallets.set(tx.organization_id, (wallets.get(tx.organization_id) ?? 0) + tx.amount);
    }

    return (orgsRes.data ?? []).map((org) => {
      const owner = profiles.get(org.owner_id);
      const sub = subs.get(org.id);
      return {
        id: org.id,
        name: org.name,
        ownerEmail: owner?.email ?? null,
        ownerName: owner?.full_name ?? null,
        businessType: biz.get(org.id) ?? null,
        accountStatus: org.account_status,
        plan: sub?.plan ?? null,
        subscriptionStatus: sub?.status ?? null,
        phoneNumber: numbers.get(org.id) ?? null,
        walletBalance: wallets.get(org.id) ?? 0,
        nextBillingAt: org.next_billing_at,
        setupPaidAt: org.setup_paid_at,
        createdAt: org.created_at,
      };
    });
  });

/** Full profile of a single customer organization. */
export const getCustomerDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const orgId = data.orgId;

    const [org, business, sub, members, numbers, locks, wallet, payments, invoices, calls, agent, audit] = await Promise.all([
      supabaseAdmin.from("organizations").select("*").eq("id", orgId).maybeSingle(),
      supabaseAdmin.from("businesses").select("*").eq("organization_id", orgId).maybeSingle(),
      supabaseAdmin.from("subscriptions").select("*").eq("organization_id", orgId).maybeSingle(),
      supabaseAdmin.from("organization_members").select("user_id, role, created_at").eq("organization_id", orgId),
      supabaseAdmin.from("phone_numbers").select("*").eq("organization_id", orgId),
      supabaseAdmin.from("organization_feature_locks").select("feature, locked, note, updated_at").eq("organization_id", orgId),
      supabaseAdmin.from("wallet_transactions").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(100),
      supabaseAdmin.from("payments").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(50),
      supabaseAdmin.from("invoices").select("*").eq("organization_id", orgId).order("issued_at", { ascending: false }).limit(50),
      supabaseAdmin.from("call_logs").select("id, direction, status, duration_seconds, started_at").eq("organization_id", orgId).order("started_at", { ascending: false }).limit(25),
      supabaseAdmin.from("agent_configs").select("*").eq("organization_id", orgId).maybeSingle(),
      supabaseAdmin.from("audit_logs").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(50),
    ]);

    if (!org.data) throw new Error("Customer not found");

    const memberIds = (members.data ?? []).map((m) => m.user_id);
    const { data: profiles } = memberIds.length
      ? await supabaseAdmin.from("profiles").select("id, full_name, email, phone").in("id", memberIds)
      : { data: [] as { id: string; full_name: string | null; email: string | null; phone: string | null }[] };

    return {
      organization: org.data,
      business: business.data ?? null,
      subscription: sub.data ?? null,
      agent: agent.data ?? null,
      members: (members.data ?? []).map((m) => ({
        ...m,
        profile: (profiles ?? []).find((p) => p.id === m.user_id) ?? null,
      })),
      numbers: numbers.data ?? [],
      locks: locks.data ?? [],
      wallet: wallet.data ?? [],
      walletBalance: (wallet.data ?? []).reduce((s, t) => s + t.amount, 0),
      payments: payments.data ?? [],
      invoices: invoices.data ?? [],
      calls: calls.data ?? [],
      audit: audit.data ?? [],
    };
  });

/** Lock or unlock a single feature for one customer (null clears the override). */
export const setFeatureLock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; feature: string; locked: boolean | null; reason?: string }) => {
    if (!input?.orgId || !input.feature) throw new Error("orgId and feature are required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "settings.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: previous } = await supabaseAdmin
      .from("organization_feature_locks")
      .select("locked")
      .eq("organization_id", data.orgId)
      .eq("feature", data.feature)
      .maybeSingle();

    if (data.locked === null) {
      const { error } = await supabaseAdmin
        .from("organization_feature_locks")
        .delete()
        .eq("organization_id", data.orgId)
        .eq("feature", data.feature);
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin.from("organization_feature_locks").upsert(
        {
          organization_id: data.orgId,
          feature: data.feature,
          locked: data.locked,
          note: data.reason ?? null,
          updated_by: admin.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,feature" },
      );
      if (error) throw error;
    }

    await writeAudit(admin, {
      action: data.locked === null ? "feature.override_cleared" : data.locked ? "feature.locked" : "feature.unlocked",
      entityType: "feature_lock",
      entityId: data.feature,
      organizationId: data.orgId,
      oldValue: previous ? { locked: previous.locked } : null,
      newValue: data.locked === null ? null : { locked: data.locked },
      reason: data.reason ?? null,
    });

    return { ok: true as const };
  });

/** Change a customer's account status (suspend, reactivate, etc.). */
export const setAccountStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; status: AccountStatus; reason: string }) => {
    if (!input?.orgId || !ACCOUNT_STATUSES.includes(input.status)) throw new Error("Invalid status");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "customers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: previous } = await supabaseAdmin
      .from("organizations")
      .select("account_status")
      .eq("id", data.orgId)
      .maybeSingle();

    const { error } = await supabaseAdmin
      .from("organizations")
      .update({ account_status: data.status })
      .eq("id", data.orgId);
    if (error) throw error;

    await writeAudit(admin, {
      action: "customer.status_changed",
      entityType: "organization",
      entityId: data.orgId,
      organizationId: data.orgId,
      oldValue: previous,
      newValue: { account_status: data.status },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/** Immutable wallet credit/debit. Never edits history. */
export const adjustWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; amount: number; kind: string; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!Number.isFinite(input.amount) || input.amount === 0) throw new Error("Amount must be a non-zero number");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "wallet.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin.from("wallet_transactions").insert({
      organization_id: data.orgId,
      amount: Math.round(data.amount),
      kind: data.kind || "manual_adjustment",
      description: data.reason,
      created_by: admin.userId,
    });
    if (error) throw error;

    await writeAudit(admin, {
      action: data.amount > 0 ? "wallet.credited" : "wallet.debited",
      entityType: "wallet_transaction",
      organizationId: data.orgId,
      newValue: { amount: Math.round(data.amount), kind: data.kind },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/** Read every platform setting (admins see private keys too). */
export const listPlatformSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("platform_settings").select("*").order("key");
    if (error) throw error;
    return data;
  });

/** Update a platform setting (pricing, enforcement, thresholds, defaults). */
export const updatePlatformSetting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { key: string; value: Record<string, unknown>; reason: string }) => {
    if (!input?.key) throw new Error("key is required");
    if (!input.value || typeof input.value !== "object") throw new Error("value must be an object");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const capability = data.key.startsWith("pricing.") ? "pricing.write" : "settings.write";
    const admin = await assertPlatformAdmin(context.supabase, context.userId, capability);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: previous } = await supabaseAdmin
      .from("platform_settings")
      .select("value")
      .eq("key", data.key)
      .maybeSingle();

    const { error } = await supabaseAdmin
      .from("platform_settings")
      .upsert({ key: data.key, value: data.value as never, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;

    await writeAudit(admin, {
      action: "platform_setting.updated",
      entityType: "platform_setting",
      entityId: data.key,
      oldValue: previous?.value ?? null,
      newValue: data.value,
      reason: data.reason,
    });
    return { ok: true as const };
  });

/** Audit trail viewer. */
export const listAuditLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { orgId?: string; action?: string; limit?: number }) => input ?? {})
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "audit.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Math.min(data.limit ?? 200, 500));
    if (data.orgId) query = query.eq("organization_id", data.orgId);
    if (data.action) query = query.ilike("action", `%${data.action}%`);
    const { data: rows, error } = await query;
    if (error) throw error;
    return rows;
  });

/** Platform admin team management. */
export const listPlatformAdmins = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("platform_admins").select("*").order("created_at");
    if (error) throw error;
    return data;
  });

export const upsertPlatformAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { email: string; role: PlatformRole; isActive: boolean; reason: string }) => {
    if (!input?.email?.includes("@")) throw new Error("A valid email is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "admins.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const email = data.email.trim().toLowerCase();
    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name")
      .ilike("email", email)
      .maybeSingle();
    if (!existingProfile) {
      throw new Error("No account exists with that email yet — ask them to sign up first");
    }

    const { error } = await supabaseAdmin.from("platform_admins").upsert(
      {
        user_id: existingProfile.id,
        email,
        name: existingProfile.full_name,
        role: data.role,
        is_active: data.isActive,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;

    await writeAudit(admin, {
      action: data.isActive ? "platform_admin.granted" : "platform_admin.revoked",
      entityType: "platform_admin",
      entityId: existingProfile.id,
      newValue: { email, role: data.role, is_active: data.isActive },
      reason: data.reason,
    });
    return { ok: true as const };
  });
