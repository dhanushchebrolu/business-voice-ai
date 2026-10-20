import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  toWaId,
  isWaId,
  parseConsentKeyword,
  latestConsent,
  checkSendPermission,
  recordConsentEvent,
} from "./whatsapp-consent.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const event = (
  waId: string,
  scope: string,
  action: string,
  minutesAgo: number,
  business = "biz-a",
) => ({
  organization_id: "org-a",
  business_id: business,
  wa_id: waId,
  scope,
  action,
  source: "staff_attested",
  created_at: at(minutesAgo),
});

describe("toWaId", () => {
  test("E.164 → digits; national numbers only with the business's country; garbage → null", () => {
    assert.equal(toWaId("+919876543210", null), "919876543210");
    assert.equal(toWaId("98765 43210", "IN"), "919876543210");
    assert.equal(toWaId("9876543210", null), null, "never guesses a country");
    assert.equal(toWaId("12345", "IN"), null);
    assert.equal(toWaId("", "IN"), null);
    assert.equal(toWaId(null, "IN"), null);
  });
  test("isWaId", () => {
    assert.equal(isWaId("919876543210"), true);
    assert.equal(isWaId("+919876543210"), false);
    assert.equal(isWaId("0123"), false);
  });
});

describe("parseConsentKeyword", () => {
  test("only a message that is just the keyword counts", () => {
    for (const t of ["STOP", "stop", " Stop. ", "unsubscribe", "Opt out", "band karo"]) {
      assert.equal(parseConsentKeyword(t), "opt_out", t);
    }
    for (const t of ["START", "subscribe", "opt in"])
      assert.equal(parseConsentKeyword(t), "opt_in", t);
    for (const t of [
      "stop by tomorrow?",
      "can you stop the reminder for friday",
      "start time?",
      "hi",
    ]) {
      assert.equal(parseConsentKeyword(t), null, t);
    }
  });
});

describe("latestConsent / checkSendPermission", () => {
  test("the latest event per number and scope wins; scopes and businesses are independent", async () => {
    const db = createFakeDb({
      whatsapp_consent_events: [
        event("911", "marketing", "opt_in", 100),
        event("911", "marketing", "opt_out", 10),
        event("912", "marketing", "opt_out", 100),
        event("912", "marketing", "opt_in", 10),
        event("913", "transactional", "opt_in", 10),
        event("914", "marketing", "opt_in", 10, "biz-other"),
      ],
    });
    const latest = await latestConsent(db.client, "biz-a", "marketing", [
      "911",
      "912",
      "913",
      "914",
    ]);
    assert.equal(latest.get("911"), "opt_out");
    assert.equal(latest.get("912"), "opt_in");
    assert.equal(latest.has("913"), false, "transactional consent isn't marketing consent");
    assert.equal(latest.has("914"), false, "another business's consent doesn't count");
  });

  test("marketing needs an explicit opt-in; transactional is allowed unless opted out; suppression always wins", async () => {
    const db = createFakeDb({
      whatsapp_consent_events: [
        event("911", "marketing", "opt_in", 5),
        event("912", "transactional", "opt_out", 5),
        event("913", "marketing", "opt_in", 5),
      ],
      whatsapp_suppressions: [
        { organization_id: "org-a", business_id: "biz-a", wa_id: "913", reason: "blocked_by_user" },
      ],
    });
    assert.deepEqual(await checkSendPermission(db.client, "biz-a", "911", "marketing"), {
      allowed: true,
    });
    assert.deepEqual(await checkSendPermission(db.client, "biz-a", "999", "marketing"), {
      allowed: false,
      reason: "no_consent",
    });
    assert.deepEqual(await checkSendPermission(db.client, "biz-a", "999", "transactional"), {
      allowed: true,
    });
    assert.deepEqual(await checkSendPermission(db.client, "biz-a", "912", "transactional"), {
      allowed: false,
      reason: "opted_out",
    });
    assert.deepEqual(await checkSendPermission(db.client, "biz-a", "913", "marketing"), {
      allowed: false,
      reason: "suppressed",
    });
  });

  test("recordConsentEvent appends (never updates) and truncates evidence", async () => {
    const db = createFakeDb();
    await recordConsentEvent(db.client, {
      organizationId: "org-a",
      businessId: "biz-a",
      waId: "911",
      scope: "marketing",
      action: "opt_in",
      source: "staff_attested",
      evidence: "x".repeat(2000),
    });
    const rows = db.rows("whatsapp_consent_events");
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0]!["evidence"]).length, 1000);
    assert.ok(db.log.every((l) => l.op !== "update" && l.op !== "delete"));
  });
});
