/**
 * Server-generated, short-lived CSRF state for OAuth flows (spec: "the
 * OAuth state must be generated server-side, be unpredictable, be
 * short-lived, be associated with authenticated organization/user, prevent
 * CSRF, be validated during callback, not contain secrets, not trust
 * organization_id from browser").
 *
 * Provider-generic (the oauth_states table has a `provider` column) so a
 * future non-Google OAuth integration reuses this module rather than
 * duplicating it — callers pass their own provider tag.
 *
 * Tenant identity for the OAuth callback comes ONLY from the row this
 * module writes at connect-time (organization_id/business_id/user_id,
 * captured from the already-authenticated session that initiated the
 * connect flow) — the callback route never trusts a browser-supplied
 * organization_id query parameter, closing exactly the hole spec section
 * 58 warns about.
 *
 * The privileged Supabase client is an explicit parameter, not a module-
 * level import — matching whatsapp-onboarding.server.ts's own convention
 * (a pure, DI'd core, testable without a live database or module mocking).
 * oauth_states has no authenticated-readable policy at all (see the
 * migration), so callers must pass the service-role client.
 */

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

const STATE_BYTES = 32;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a human to complete Google's consent screen, short enough to keep the CSRF window tight.

export class OAuthStateError extends Error {}

export interface OAuthStateContext {
  organizationId: string;
  businessId: string | null;
  userId: string;
}

export interface CreateOAuthStateInput extends OAuthStateContext {
  provider: string;
  /** Where to send the browser after the callback finishes (e.g. "/app/integrations"). Never trusted as a redirect target for anything other than ClickAI's own app — see the callback route's own allowlist check. */
  redirectTo?: string;
}

/**
 * Generates an unpredictable, single-use state token, stores it server-side
 * tied to the caller's already-authenticated org/business/user, and
 * returns the token to embed in the OAuth authorization URL. Never
 * returns or logs anything else about the caller's session.
 */
export async function createOAuthState(
  supabaseAdmin: Client,
  input: CreateOAuthStateInput,
): Promise<string> {
  const state = randomBytes(STATE_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

  const { error } = await supabaseAdmin.from("oauth_states").insert({
    state,
    provider: input.provider,
    organization_id: input.organizationId,
    business_id: input.businessId,
    user_id: input.userId,
    redirect_to: input.redirectTo ?? null,
    expires_at: expiresAt,
  });
  if (error) throw new OAuthStateError(`Failed to create OAuth state: ${error.message}`);

  return state;
}

/**
 * Validates and consumes a state token from the OAuth callback. Throws
 * OAuthStateError on anything other than a fresh, unexpired, unconsumed
 * state for the expected provider — never returns a partial/best-effort
 * result. Consuming is a single atomic UPDATE ... WHERE consumed_at IS
 * NULL (not a read-then-write), so a state token can never be replayed
 * even under concurrent callback requests.
 */
export async function consumeOAuthState(
  supabaseAdmin: Client,
  provider: string,
  state: string,
): Promise<OAuthStateContext & { redirectTo: string | null }> {
  if (!state) throw new OAuthStateError("Missing OAuth state.");

  const { data, error } = await supabaseAdmin
    .from("oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state)
    .eq("provider", provider)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("organization_id, business_id, user_id, redirect_to")
    .maybeSingle();

  if (error) throw new OAuthStateError(`Failed to validate OAuth state: ${error.message}`);
  if (!data) {
    throw new OAuthStateError(
      "OAuth state is invalid, expired, or has already been used. Please try connecting again.",
    );
  }

  return {
    organizationId: data.organization_id,
    businessId: data.business_id,
    userId: data.user_id,
    redirectTo: data.redirect_to,
  };
}
