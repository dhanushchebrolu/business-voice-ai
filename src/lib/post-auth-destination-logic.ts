export type PostAuthDestination = "/admin" | "/app" | "/account";

/**
 * Pure decision logic, kept in its own dependency-free module so it can be
 * unit-tested without a live Supabase connection (see
 * post-auth-destination.test.ts) and without hitting bundler-only path
 * aliases that raw `node --test` can't resolve.
 *
 * - Active platform admin -> /admin
 * - Member of a non-archived organization -> /app (the customer dashboard;
 *   /app itself still gates setup/payment/suspension state)
 * - Anyone else (including a brand-new signup, which never auto-provisions
 *   a workspace) -> /account, the normal authenticated site.
 */
export function deriveDestination(input: {
  isActivePlatformAdmin: boolean;
  organizationLifecycleStatus: string | null;
}): PostAuthDestination {
  if (input.isActivePlatformAdmin) return "/admin";
  if (input.organizationLifecycleStatus && input.organizationLifecycleStatus !== "archived") return "/app";
  return "/account";
}
