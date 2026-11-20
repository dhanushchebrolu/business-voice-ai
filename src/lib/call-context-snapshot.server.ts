import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireRole, type CallerClients } from "./outbound-authorization.server.ts";
import { readContextSnapshot, type CallContextSnapshotView } from "./call-context-snapshot.ts";

type Admin = SupabaseClient<Database>;

/** Same answer for a missing call and another workspace's call, so nothing leaks. */
export const CALL_NOT_FOUND = "Call not found.";

/**
 * The snapshot of one call. The column is not granted to customers, so it is
 * only ever read here with the service role, after the caller is authorized.
 * `organizationId` scopes the read to that workspace (customer path).
 */
export async function loadCallContextSnapshot(
  admin: Admin,
  callId: string,
  organizationId: string | null,
): Promise<CallContextSnapshotView> {
  let query = admin
    .from("call_logs")
    .select("id, organization_id, campaign_id, campaign_context_snapshot")
    .eq("id", callId);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data: call, error } = await query.maybeSingle();
  if (error) throw error;
  if (!call) throw new Error(CALL_NOT_FOUND);
  if (!call.campaign_id) return { state: "not_campaign" };

  const { data: row, error: campaignError } = await admin
    .from("campaigns")
    .select("id, organization_id, name, context_version, context_reviewed_at")
    .eq("id", call.campaign_id)
    .eq("organization_id", call.organization_id)
    .maybeSingle();
  if (campaignError) throw campaignError;
  const campaign = row
    ? {
        id: row.id,
        name: row.name ?? null,
        currentReviewedAt: row.context_reviewed_at,
        currentVersion: row.context_version,
      }
    : null;

  if (call.campaign_context_snapshot == null) return { state: "no_snapshot", campaign };
  const snapshot = readContextSnapshot(call.campaign_context_snapshot);
  if (!snapshot) return { state: "unreadable", campaign };
  return {
    state: "snapshot",
    snapshot,
    campaign,
    currentDiffers:
      campaign !== null &&
      (!sameInstant(campaign.currentReviewedAt, snapshot.reviewedAt) ||
        campaign.currentVersion !== snapshot.version),
  };
}

/** Timestamps from jsonb and from a column can differ in format; compare the instant. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/** Customer path: any member of the call's own workspace may read it. */
export async function callContextSnapshotForMember(
  clients: CallerClients,
  userId: string,
  callId: string,
): Promise<CallContextSnapshotView> {
  const { data, error } = await clients.supabaseAdmin
    .from("call_logs")
    .select("organization_id")
    .eq("id", callId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.organization_id) throw new Error(CALL_NOT_FOUND);
  const orgId = await requireRole(clients, userId, data.organization_id, false, CALL_NOT_FOUND);
  return loadCallContextSnapshot(clients.supabaseAdmin, callId, orgId);
}
