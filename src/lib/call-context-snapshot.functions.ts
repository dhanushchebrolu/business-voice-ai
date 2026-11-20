import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Read-only access to the campaign context a call was admitted with. The
 * snapshot column has no customer grant: these server functions are the only
 * way to read it, after authorization, and only ever return one call's.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateCallId(input: { callId: string }) {
  if (typeof input?.callId !== "string" || !UUID.test(input.callId))
    throw new Error("callId is required");
  return { callId: input.callId };
}

/** A member of the call's own workspace. */
export const getCallContextSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateCallId)
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { callContextSnapshotForMember } = await import("@/lib/call-context-snapshot.server");
    return callContextSnapshotForMember(
      { supabase: context.supabase as typeof supabaseAdmin, supabaseAdmin },
      context.userId,
      data.callId,
    );
  });

/** A platform admin, with the same capability as the admin call detail. */
export const getAdminCallContextSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateCallId)
  .handler(async ({ data, context }) => {
    const { assertPlatformAdmin } = await import("@/lib/platform-admin.server");
    await assertPlatformAdmin(context.supabase, context.userId, "billing.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadCallContextSnapshot } = await import("@/lib/call-context-snapshot.server");
    return loadCallContextSnapshot(supabaseAdmin, data.callId, null);
  });
