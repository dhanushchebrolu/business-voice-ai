import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the Razorpay webhook route's automatic
 * provisioning wiring (Task #93). createFileRoute-based handler, so —
 * consistent with this repo's established convention for routes this test
 * runner cannot safely import/execute — a source scan.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "razorpay.ts"), "utf8");

describe("setup_fee branch — automatic provisioning", () => {
  test("imports and calls provisionOrganizationAfterPayment inside the setup_fee branch, after the lifecycle_status update", () => {
    const branchIdx = src.indexOf('if (order.purpose === "setup_fee")');
    assert.ok(branchIdx > -1);
    const nextBranchIdx = src.indexOf('if (order.purpose === "monthly_plan")');
    const branchSrc = src.slice(branchIdx, nextBranchIdx > -1 ? nextBranchIdx : undefined);

    assert.match(branchSrc, /await import\(\s*"@\/lib\/provisioning-orchestrator\.server"\s*\)/);
    const lifecycleUpdateIdx = branchSrc.indexOf('.eq("id", order.organization_id);');
    const provisioningCallIdx = branchSrc.indexOf("await provisionOrganizationAfterPayment(");
    assert.ok(lifecycleUpdateIdx > -1 && provisioningCallIdx > -1);
    assert.ok(
      lifecycleUpdateIdx < provisioningCallIdx,
      "the lifecycle_status write must happen before automatic provisioning runs",
    );
    assert.match(branchSrc, /supabaseAdmin,\s*\n\s*order\.organization_id,/);
  });

  test("the call is awaited directly, not wrapped in its own try/catch — provisionOrganizationAfterPayment guarantees it never throws", () => {
    const branchIdx = src.indexOf('if (order.purpose === "setup_fee")');
    const nextBranchIdx = src.indexOf('if (order.purpose === "monthly_plan")');
    const branchSrc = src.slice(branchIdx, nextBranchIdx > -1 ? nextBranchIdx : undefined);
    assert.doesNotMatch(branchSrc, /try\s*\{[\s\S]*provisionOrganizationAfterPayment/);
  });

  test("does not fake success: the result note is logged, not discarded", () => {
    assert.match(src, /console\.log\(\s*\n?\s*"razorpay:webhook_auto_provisioning"/);
    assert.match(src, /provisioning\.note/);
  });

  test("automatic provisioning only runs for setup_fee, never for monthly_plan recurring billing", () => {
    const monthlyIdx = src.indexOf('if (order.purpose === "monthly_plan")');
    const nextIdx = src.indexOf('if (event.event === "payment.failed"');
    const monthlySrc = src.slice(monthlyIdx, nextIdx > -1 ? nextIdx : undefined);
    assert.doesNotMatch(monthlySrc, /provisionOrganizationAfterPayment/);
  });
});

describe("existing signature/idempotency/lifecycle behavior is unchanged", () => {
  test("still verifies the signature before reading anything from the payload", () => {
    const sigIdx = src.indexOf("verifySignature(raw, signature, secret)");
    const parseIdx = src.indexOf("JSON.parse(raw)");
    assert.ok(sigIdx > -1 && parseIdx > -1);
    assert.ok(sigIdx < parseIdx);
  });

  test("still relies on the (provider, event_id) unique index for idempotency", () => {
    assert.match(src, /provider:\s*"razorpay"/);
    assert.match(src, /event_id:\s*eventId/);
    assert.match(src, /dedupeError\.code === "23505"/);
  });

  test("still only advances lifecycle_status forward from not_provisioned/setup_payment_pending", () => {
    assert.match(
      src,
      /current\.lifecycle_status === "not_provisioned" \|\|\s*\n?\s*current\.lifecycle_status === "setup_payment_pending"/,
    );
  });
});
