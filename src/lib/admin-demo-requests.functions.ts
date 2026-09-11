import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";

/**
 * Admin CRM surface for demo_requests (20260905080000, extended by
 * 20260911090000). The public "Book a demo" form inserts rows here directly
 * (RLS: anon/authenticated INSERT-only, column-scoped to the fields the form
 * collects); everything below is the platform-admin read/triage side.
 * Never touches the public INSERT path or the form itself.
 */

export const DEMO_REQUEST_STATUSES = ["NEW", "CONTACTED", "DEMO_SCHEDULED", "WON", "LOST"] as const;
export type DemoRequestStatus = (typeof DEMO_REQUEST_STATUSES)[number];

export interface AdminDemoRequestRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  business_name: string | null;
  message: string | null;
  status: DemoRequestStatus;
  admin_notes: string | null;
  converted: boolean;
  organization_id: string | null;
  created_at: string;
  updated_at: string;
  organization: { id: string; name: string; client_id: string; lifecycle_status: string } | null;
}

/** List every demo request, newest first, with the converted org's status joined in read-only. */
export const listDemoRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { status?: DemoRequestStatus; search?: string }) => input ?? {})
  .handler(async ({ data, context }): Promise<AdminDemoRequestRow[]> => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let query = supabaseAdmin
      .from("demo_requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (data.status) query = query.eq("status", data.status);
    if (data.search?.trim()) {
      const term = data.search.trim();
      query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,business_name.ilike.%${term}%`);
    }
    const { data: rows, error } = await query;
    if (error) throw error;

    const orgIds = [
      ...new Set(
        (rows ?? []).map((r) => r.organization_id).filter((id): id is string => Boolean(id)),
      ),
    ];
    const orgsById = new Map<
      string,
      { id: string; name: string; client_id: string; lifecycle_status: string }
    >();
    if (orgIds.length) {
      const { data: orgs } = await supabaseAdmin
        .from("organizations")
        .select("id, name, client_id, lifecycle_status")
        .in("id", orgIds);
      for (const org of orgs ?? []) orgsById.set(org.id, org);
    }

    return (rows ?? []).map((row) => ({
      ...row,
      status: row.status as DemoRequestStatus,
      organization: row.organization_id ? (orgsById.get(row.organization_id) ?? null) : null,
    }));
  });

/** Move a demo request through the sales pipeline. Converting to a customer is a separate, explicit action (see admin-clients.functions.ts's createClientAccount sourceDemoRequestId). */
export const updateDemoRequestStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; status: DemoRequestStatus }) => {
    if (!input?.id) throw new Error("id is required");
    if (!DEMO_REQUEST_STATUSES.includes(input.status)) throw new Error("Invalid status");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "customers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: previous } = await supabaseAdmin
      .from("demo_requests")
      .select("status")
      .eq("id", data.id)
      .maybeSingle();
    if (!previous) throw new Error("Demo request not found");

    const { error } = await supabaseAdmin
      .from("demo_requests")
      .update({ status: data.status })
      .eq("id", data.id);
    if (error) throw error;

    await writeAudit(admin, {
      action: "demo_request.status_updated",
      entityType: "demo_request",
      entityId: data.id,
      oldValue: { status: previous.status },
      newValue: { status: data.status },
    });
    return { ok: true as const };
  });

/** Internal-only notes — never returned by the public form's INSERT path, never visible to the submitter. */
export const updateDemoRequestNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; notes: string }) => {
    if (!input?.id) throw new Error("id is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "customers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: previous } = await supabaseAdmin
      .from("demo_requests")
      .select("admin_notes")
      .eq("id", data.id)
      .maybeSingle();
    if (!previous) throw new Error("Demo request not found");

    const { error } = await supabaseAdmin
      .from("demo_requests")
      .update({ admin_notes: data.notes })
      .eq("id", data.id);
    if (error) throw error;

    await writeAudit(admin, {
      action: "demo_request.notes_updated",
      entityType: "demo_request",
      entityId: data.id,
      oldValue: { admin_notes: previous.admin_notes },
      newValue: { admin_notes: data.notes },
    });
    return { ok: true as const };
  });
