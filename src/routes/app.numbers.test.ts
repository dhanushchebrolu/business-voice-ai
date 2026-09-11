import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the customer-facing "Get / Attach Sarvam Number"
 * UI (Part 10). Source-scanned — no jsdom/RTL in this repo's test runner.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.numbers.tsx"), "utf8");

describe("the request button only calls the gated server function — no direct table write from the client", () => {
  test("requestPhoneNumber is imported from the customer-facing functions module and invoked via useServerFn", () => {
    assert.match(
      src,
      /import \{ requestPhoneNumber \} from "@\/lib\/telephony-customer\.functions"/,
    );
    assert.match(src, /useServerFn\(requestPhoneNumber\)/);
  });

  test("no direct insert into phone_numbers or customer_events from this route file", () => {
    assert.doesNotMatch(src, /supabase\s*\n?\s*\.from\("phone_numbers"\)[\s\S]{0,100}\.insert\(/);
    assert.doesNotMatch(src, /supabase\s*\n?\s*\.from\("customer_events"\)[\s\S]{0,100}\.insert\(/);
  });
});

describe("three distinct states: no number, request pending, active number", () => {
  test("the request button only renders when there is no active number and no existing request", () => {
    assert.match(src, /Get \/ Attach Sarvam Number/);
  });

  test("an already-submitted request shows a distinct waiting state, not the button again", () => {
    assert.match(src, /Request submitted/);
  });

  test("provider-setup-required is a distinct, explicit state — never silently treated as success", () => {
    assert.match(src, /providerSetupRequired/);
    assert.match(src, /Provider setup required/);
  });

  test("an active number shows provider/status/inbound/outbound/agent/deployment/created — not just the bare e164", () => {
    const idx = src.indexOf("active.e164");
    const block = src.slice(idx, idx + 1500);
    assert.match(block, /active\.status/);
    assert.match(block, /active\.provider/);
    assert.match(block, /active\.inbound_enabled/);
    assert.match(block, /active\.outbound_enabled/);
    assert.match(block, /active\.agent_config_id/);
    assert.match(block, /active\.provider_deployment_id/);
    assert.match(block, /active\.created_at/);
  });
});

describe("the request state itself is read from the server (RLS-scoped), not only from local component state", () => {
  test("numberRequestQuery reads customer_events via the RLS-scoped browser client, so a page refresh doesn't lose the submitted state", () => {
    assert.match(src, /numberRequestQuery/);
    assert.match(src, /from\("customer_events"\)/);
    assert.match(src, /eq\("kind", "phone_number_requested"\)/);
  });
});
