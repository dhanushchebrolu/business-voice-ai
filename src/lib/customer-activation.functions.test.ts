import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { customerActivationStatus } from "./customer-activation-status.ts";

/**
 * Customer "Activate Number" (Phase 5). The server function is a
 * createServerFn handler, so (repo convention) its guards are checked by
 * source scan; the customer-facing status mapping is tested directly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "customer-activation.functions.ts"), "utf8");
const handler = (name: string) => {
  const i = src.indexOf(`export const ${name}`);
  assert.ok(i > -1, name);
  const next = src.indexOf("export const ", i + 1);
  return src.slice(i, next === -1 ? undefined : next);
};

describe("ownership and organization isolation", () => {
  test("both handlers require an authenticated session and an OWNER membership of that exact organization", () => {
    for (const name of ["activateMyNumber", "getMyActivationStatus"]) {
      const h = handler(name);
      assert.match(h, /middleware\(\[requireSupabaseAuth\]\)/, name);
      assert.match(h, /await assertOwner\(context\.supabase, context\.userId, data\.orgId\)/, name);
    }
    const owner = src.slice(src.indexOf("async function assertOwner"));
    assert.match(owner, /\.eq\("user_id", userId\)/);
    assert.match(owner, /\.eq\("organization_id", orgId\)/);
    assert.match(owner, /\.eq\("role", "owner"\)/);
    assert.match(owner, /Only the workspace owner/);
  });

  test("the membership check uses the caller's RLS-scoped client, never the service role", () => {
    const owner = src.slice(src.indexOf("async function assertOwner"), src.indexOf("export const"));
    assert.doesNotMatch(owner, /supabaseAdmin/);
  });

  test("activation checks ownership before the feature gate and before any provisioning work", () => {
    const h = handler("activateMyNumber");
    const owner = h.indexOf("assertOwner(");
    const gate = h.indexOf('assertFeatureUnlocked(data.orgId, "phone")');
    const run = h.indexOf("runProvisioning(");
    assert.ok(owner > -1 && gate > owner && run > gate);
  });
});

describe("eligibility and duplicates", () => {
  test("eligibility is the existing phone feature gate (no new payment rule)", () => {
    const h = handler("activateMyNumber");
    assert.match(h, /assertFeatureUnlocked\(data\.orgId, "phone"\)/);
    assert.doesNotMatch(h, /lifecycle_status|setup_paid|payment/i);
  });

  test("starts the shared provisioning run as customer_activate, so the one-active-run index applies", () => {
    const h = handler("activateMyNumber");
    assert.match(h, /trigger: "customer_activate"/);
    assert.match(h, /if \(!run\.claimed \|\| !run\.result\)/);
  });

  test("a run that just finished is reused instead of starting another", () => {
    assert.match(handler("activateMyNumber"), /ACTIVATION_REUSE_MS/);
  });
});

describe("what the customer is told", () => {
  test("plain language only, never internal detail", () => {
    assert.equal(customerActivationStatus("active").status, "live");
    assert.equal(customerActivationStatus("waiting_for_onboarding").status, "needs_setup");
    for (const s of ["failed", "verification_failed", "manual_action_required"])
      assert.equal(customerActivationStatus(s).status, "problem", s);
    for (const s of [
      "waiting_for_number_confirmation",
      "waiting_for_agent",
      "waiting_for_voice_language",
      "waiting_for_integration_credential",
      null,
    ])
      assert.equal(customerActivationStatus(s).status, "preparing", String(s));
    for (const s of ["active", "failed", "waiting_for_agent"])
      assert.doesNotMatch(customerActivationStatus(s).message, /Sarvam|deployment|dep-|app/i);
  });
});
