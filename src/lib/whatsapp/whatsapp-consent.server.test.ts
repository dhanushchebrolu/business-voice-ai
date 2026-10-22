import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  toWaId,
  isWaId,
  parseConsentKeyword,
  consentScopesForKeyword,
  latestConsent,
  checkSendPermission,
  recordConsentEvent,
  latestConsentForBusiness,
  foldLatestConsent,
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

describe("consentScopesForKeyword", () => {
  test("STOP opts out of everything; START only restores transactional messages", () => {
    assert.deepEqual(consentScopesForKeyword("opt_out"), ["transactional", "marketing"]);
    assert.deepEqual(consentScopesForKeyword("opt_in"), ["transactional"]);
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

describe("latest consent is complete and deterministic", () => {
  const many = (waId: string, n: number, action: string, startMinutesAgo: number) =>
    Array.from({ length: n }, (_, i) =>
      event(waId, "marketing", action, startMinutesAgo - i * 0.001),
    );

  test("a row cap (PostgREST max-rows) can't hide an older opt-out behind another number's newer rows", async () => {
    // 1,200 newer rows for one number push the other number's opt-out past
    // the first 1,000 rows; every page must still be read.
    const db = createFakeDb(
      {
        whatsapp_consent_events: [
          ...many("911", 1200, "opt_in", 10),
          event("922", "marketing", "opt_in", 300),
          event("922", "marketing", "opt_out", 200),
        ],
      },
      { maxRows: 1000 },
    );
    const latest = await latestConsent(db.client, "biz-a", "marketing", ["911", "922"]);
    assert.equal(latest.get("922"), "opt_out");
    assert.equal(latest.get("911"), "opt_in");
    assert.deepEqual(await checkSendPermission(db.client, "biz-a", "922", "marketing"), {
      allowed: false,
      reason: "opted_out",
    });
  });

  test("latestConsentForBusiness reads every page too", async () => {
    const db = createFakeDb(
      {
        whatsapp_consent_events: [
          ...many("911", 1500, "opt_in", 10),
          event("933", "marketing", "opt_in", 900),
          event("944", "marketing", "opt_in", 900),
          event("944", "marketing", "opt_out", 800),
        ],
      },
      { maxRows: 1000 },
    );
    const all = await latestConsentForBusiness(db.client, "biz-a", "marketing");
    assert.equal(all.get("933")?.action, "opt_in", "an old opt-in is still found");
    assert.equal(all.get("944")?.action, "opt_out", "an old opt-out is still found");
  });

  test("ties: same instant → opt-out wins, in either order", () => {
    const at = "2026-10-20T05:00:00.000Z";
    for (const rows of [
      [
        { wa_id: "9", action: "opt_in", created_at: at },
        { wa_id: "9", action: "opt_out", created_at: at },
      ],
      [
        { wa_id: "9", action: "opt_out", created_at: at },
        { wa_id: "9", action: "opt_in", created_at: at },
      ],
    ]) {
      assert.equal(foldLatestConsent(rows).get("9")?.action, "opt_out");
    }
    assert.equal(
      foldLatestConsent([
        { wa_id: "9", action: "opt_out", created_at: "2026-10-20T05:00:00.000Z" },
        { wa_id: "9", action: "opt_in", created_at: "2026-10-20T05:00:00.001Z" },
      ]).get("9")?.action,
      "opt_in",
      "a strictly newer opt-in wins",
    );
  });
});
