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
