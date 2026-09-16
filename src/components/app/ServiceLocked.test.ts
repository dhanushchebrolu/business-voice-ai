import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * ServiceLocked only ever renders when a caller's featureLocksQuery already
 * reported a real entitlement lock (see every route's own `locked ?
 * <ServiceLocked .../> : null` guard, e.g. app.numbers.tsx, app.agent.tsx) —
 * it is always a payment/entitlement warning (requirement 4), never a
 * genuine setup-completeness message (requirement 5's exceptions live
 * elsewhere, e.g. AccountStatusPanel's channel hints). Safe to suppress this
 * whole component while BYPASS_BILLING_GATES mirrors the backend bypass.
 *
 * Source-scanned, matching this repo's established convention for JSX files
 * this Node-native test runner can't import/render directly.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ServiceLocked.tsx"),
  "utf8",
);

describe("ServiceLocked suppresses itself while the billing bypass is active", () => {
  test("reads the bypass flag through the safe server-function channel, never process.env directly", () => {
    assert.match(src, /import \{ getBillingBypassStatus \} from "@\/lib\/billing\.functions";/);
    assert.match(src, /useServerFn\(getBillingBypassStatus\)/);
    assert.doesNotMatch(src, /process\.env/);
  });

  test("returns null before rendering any lock title/description/CTA when bypassed", () => {
    const bypassCheckIdx = src.indexOf("if (bypass?.bypassed === true) return null;");
    assert.ok(bypassCheckIdx > -1);
    const labelIdx = src.indexOf("const label = FEATURE_LABEL[feature]");
    assert.ok(labelIdx > -1);
    assert.ok(
      bypassCheckIdx < labelIdx,
      "the bypass short-circuit must run before any lock message is computed",
    );
  });
});
