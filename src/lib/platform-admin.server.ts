import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Server-only platform administration guard.
 *
 * Platform admin authority is completely separate from a customer's
 * organization role: being an "owner"/"admin" of an organization grants
 * nothing here. Every privileged admin operation must call
 * `assertPlatformAdmin` before touching data, and every mutation must be
 * written to `audit_logs`.
 */

export type PlatformRole = Database["public"]["Enums"]["platform_role"];

export type AdminCapability =
  | "customers.read"
  | "customers.write"
  | "billing.read"
  | "billing.write"
  | "pricing.write"
  | "wallet.write"
  | "numbers.write"
  | "agents.write"
  | "settings.write"
  | "admins.write"
  | "audit.read";

const READ_ONLY: AdminCapability[] = ["customers.read", "billing.read", "audit.read"];

const ROLE_CAPABILITIES: Record<PlatformRole, AdminCapability[]> = {
  super_admin: [
    "customers.read",
    "customers.write",
    "billing.read",
    "billing.write",
    "pricing.write",
    "wallet.write",
    "numbers.write",
    "agents.write",
    "settings.write",
    "admins.write",
    "audit.read",
  ],
  admin: [...READ_ONLY, "customers.write", "numbers.write", "agents.write", "settings.write"],
  finance: [...READ_ONLY, "billing.write", "pricing.write", "wallet.write"],
  support: READ_ONLY,
  operations: [...READ_ONLY, "numbers.write", "agents.write"],
};

export interface PlatformAdmin {
  userId: string;
  email: string | null;
  name: string | null;
  role: PlatformRole;
  capabilities: AdminCapability[];
}

export function capabilitiesFor(role: PlatformRole): AdminCapability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}

/**
 * Verifies the caller is an active platform admin using their own
 * (RLS-scoped) client, then returns their role + capabilities.
 */
export async function assertPlatformAdmin(
  supabase: SupabaseClient<Database>,
  userId: string,
  capability?: AdminCapability,
): Promise<PlatformAdmin> {
  const { data, error } = await supabase
    .from("platform_admins")
    .select("user_id, email, name, role, is_active")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error("Unauthorized");
  if (!data || !data.is_active) throw new Error("Unauthorized: platform admin access required");

  const role = data.role as PlatformRole;
  const capabilities = capabilitiesFor(role);
  if (capability && !capabilities.includes(capability)) {
    throw new Error(`Forbidden: your admin role (${role}) cannot perform this action`);
  }

  return { userId, email: data.email, name: data.name, role, capabilities };
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  organizationId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}

/** Appends an immutable audit record. Never throws into the caller's flow. */
export async function writeAudit(admin: PlatformAdmin, entry: AuditEntry): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("audit_logs").insert({
      admin_user_id: admin.userId,
      admin_email: admin.email,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      organization_id: entry.organizationId ?? null,
      old_value: (entry.oldValue ?? null) as never,
      new_value: (entry.newValue ?? null) as never,
      reason: entry.reason ?? null,
    });
  } catch (error) {
    console.error("audit:write_failed", error);
  }
}
