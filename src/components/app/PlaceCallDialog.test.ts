import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Source-scanned (no jsdom in this repo's runner), like the other app UI tests. */
const here = dirname(fileURLToPath(import.meta.url));
const dialog = readFileSync(join(here, "PlaceCallDialog.tsx"), "utf8");
const calls = readFileSync(join(here, "..", "..", "routes", "app.calls.tsx"), "utf8");

describe("customer 'Call a number'", () => {
  test("dials only through the gated server function, never a direct table write", () => {
    assert.match(dialog, /useServerFn\(createSarvamInstantOutboundCall\)/);
    assert.match(dialog, /useServerFn\(getOutboundCallingStatus\)/);
    assert.doesNotMatch(dialog, /\.from\(/);
    assert.doesNotMatch(dialog, /supabase/);
  });

  test("sends the canonical number, and no button submits while blocked or invalid", () => {
    assert.match(dialog, /const toE164 = normalizeCustomerPhone\(destination, null\)/);
    assert.match(
      dialog,
      /const canSubmit = blockers\.length === 0 && Boolean\(toE164\) && !placing;/,
    );
    assert.match(dialog, /disabled=\{!canSubmit\}/);
    // Non-owners see why they cannot dial; the server refuses them anyway.
    assert.match(dialog, /status\.canDial \? \[\] : \["Only a workspace owner or admin/);
  });

  test("an unconfirmed start is reported as unconfirmed, not as a success or a failure", () => {
    assert.match(
      dialog,
      /result\.outcome === "unknown"[\s\S]{0,40}toast\.warning\("Call not confirmed"/,
    );
  });

  test("a double click sends one request, and retries reuse the same request id", () => {
    // Synchronous ref guard, set before the first await.
    assert.match(
      dialog,
      /if \(!toE164 \|\| submitting\.current\) return;\s*submitting\.current = true;/,
    );
    // One id per attempt at one number; a new number gets a new id.
    assert.match(
      dialog,
      /if \(attempt\.current\?\.to !== toE164\) attempt\.current = \{ key: newRequestKey\(\), to: toE164 \};/,
    );
    assert.match(dialog, /idempotencyKey: attempt\.current\.key/);
    // Renewed only after success or when the server says the id is spent.
    assert.match(dialog, /attempt\.current = null;\s*if \(result\.duplicate\)/);
    assert.match(dialog, /if \(message === REQUEST_KEY_SPENT_MESSAGE\) attempt\.current = null;/);
  });

  test("the reason is capped like the server's objective limit", () => {
    assert.match(dialog, /const OBJECTIVE_MAX = 300;/);
    assert.match(dialog, /maxLength=\{OBJECTIVE_MAX\}/);
  });

  test("the Calls page hides the button when phone is locked and shows outbound calls by the dialled number", () => {
    assert.match(
      calls,
      /!phoneLocked \? \(\s*<PlaceCallButton organizationId=\{ws\.organization\.id\} \/>/,
    );
    assert.match(calls, /callCounterpart\(call\)/);
    assert.doesNotMatch(calls, /\{call\.caller_number \?\? "Unknown"\}/);
  });
});
