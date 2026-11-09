import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { maskPhone, summarizeCallStart } from "./sarvam-call-start-diagnostic.ts";

const AGENT = "+918047168000";
const CALLER = "+919876543210";

describe("input validation", () => {
  test("rejects non-object bodies", () => {
    for (const body of [null, undefined, "x", 42, [], [{ app_id: "a" }]]) {
      assert.equal(summarizeCallStart(body), null);
    }
  });

  test("reports missing/empty/wrong-typed fields as 'missing' instead of rejecting", () => {
    const s = summarizeCallStart({ app_id: "", interaction_id: { x: 1 } })!;
    assert.equal(s.app_id, "missing");
    assert.equal(s.interaction_id, "missing");
    assert.equal(s.agent_phone_number, "missing");
    assert.equal(s.agent_phone_e164, false);
  });

  test("accepts numeric app_version and flags E.164 agent numbers", () => {
    const s = summarizeCallStart({ agent_phone_number: ` ${AGENT} `, app_version: 3 })!;
    assert.equal(s.app_version, "3");
    assert.equal(s.agent_phone_e164, true);
    assert.equal(
      summarizeCallStart({ agent_phone_number: "08047168000" })!.agent_phone_e164,
      false,
    );
  });

  test("sanitizes and caps ID-like values and key names", () => {
    const s = summarizeCallStart({ app_id: "a\nb<script>" + "x".repeat(100), ["k\n" + "y"]: 1 })!;
    assert.match(s.app_id, /^[A-Za-z0-9._:?-]{1,64}$/);
    assert.ok(s.received_keys.every((k) => /^[A-Za-z0-9._:?-]*$/.test(k)));
  });
});

describe("safe logging", () => {
  test("maskPhone keeps only country code and last 4 digits", () => {
    assert.equal(maskPhone(AGENT), "+91******8000");
    assert.equal(maskPhone("918047168000"), "91******8000");
    assert.equal(maskPhone("@Agent phone number"), "[unrecognized len=19]");
  });

  test("no raw phone number or unknown field value ever appears in the summary", () => {
    const s = summarizeCallStart({
      agent_phone_number: AGENT,
      user_identifier: CALLER,
      user_identifier_type: "phone",
      transcript: "my card number is 4111",
      api_key: "sk_live_secret",
    })!;
    const logged = JSON.stringify(s);
    for (const secret of [AGENT, CALLER, "8047168", "9876543", "4111", "sk_live_secret"]) {
      assert.ok(!logged.includes(secret), `leaked ${secret}`);
    }
    assert.deepEqual(s.received_keys, [
      "agent_phone_number",
      "user_identifier",
      "user_identifier_type",
      "transcript",
      "api_key",
    ]);
  });
});

describe("route — auth and read-only", () => {
  const src = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../routes/api/public/sarvam/diagnostic-call-start.ts",
    ),
    "utf8",
  );

  test("secret and bearer token are checked (constant-time) before the body is read", () => {
    const authIdx = src.indexOf("constantTimeEquals(provided, secret)");
    assert.ok(authIdx > -1 && authIdx < src.indexOf("request.text()"));
    assert.ok(src.indexOf("if (!secret)") < authIdx);
  });

  test("logs only the summary, never the raw body, and never writes to the database", () => {
    assert.doesNotMatch(src, /console\.\w+\([^)]*\braw\b/);
    assert.doesNotMatch(src, /\.(insert|update|upsert|delete)\(/);
  });
});
