import { supabase } from "@/integrations/supabase/client";
import { deriveDestination, type PostAuthDestination } from "./post-auth-destination-logic";

export type { PostAuthDestination };
export { deriveDestination };

/**
 * The single place that decides where a signed-in user lands, used by every
 * entry point (email/password sign-in, Google OAuth callback, and the
 * "already signed in" redirect on /auth). Backend-authoritative: it reads
 * `platform_admins` and `organization_members` through RLS-scoped queries —
 * never inferred from the browser, a URL parameter, or the auth provider
 * used to sign in.
 */
export async function resolvePostAuthDestination(userId: string): Promise<PostAuthDestination> {
  const { data: admin } = await supabase
    .from("platform_admins")
    .select("is_active")
    .eq("user_id", userId)
    .maybeSingle();

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, organizations(lifecycle_status)")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const org = membership?.organizations as { lifecycle_status: string } | null;

  return deriveDestination({
    isActivePlatformAdmin: Boolean(admin?.is_active),
    organizationLifecycleStatus: org?.lifecycle_status ?? null,
  });
}
