import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  countBodyParams,
  templatePurposeProblem,
  parseParamSpecs,
  resolveParams,
  launchCampaign,
  changeCampaignStatus,
  dispatchWhatsAppCampaigns,
  campaignAnalytics,
  syncTemplates,
  CampaignError,
  MAX_RECIPIENT_ATTEMPTS,
} from "./whatsapp-campaigns.server.ts";
import { encryptCredential } from "./whatsapp-token-crypto.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

const saved: Record<string, string | undefined> = {};
const ENV = {
  META_APP_ID: "test-app",
  META_APP_SECRET: "test-secret",
  META_WHATSAPP_CONFIG_ID: "test-config",
  META_GRAPH_API_VERSION: "v23.0",
};
beforeEach(() => {
  for (const k of [...Object.keys(ENV), "WHATSAPP_CREDENTIAL_ENCRYPTION_KEY"])
    saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  process.env["WHATSAPP_CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const NOW = new Date("2026-10-20T06:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const consent = (waId: string, action: string, minutesAgo: number, scope = "marketing") => ({
  organization_id: "org-a",
  business_id: "biz-a",
  wa_id: waId,
  scope,
  action,
  source: "customer_form",
  created_at: ago(minutesAgo),
});

function seed(
  over: { templateStatus?: string; category?: string; campaign?: Record<string, unknown> } = {},
) {
  return {
    businesses: [{ id: "biz-a", organization_id: "org-a", name: "Smile Dental", country: "IN" }],
    whatsapp_connections: [
      {
        id: "conn-a",
        organization_id: "org-a",
        business_id: "biz-a",
        waba_id: "WABA_A",
        phone_number_id: "PN_A",
        status: "connected",
        access_token_ciphertext: encryptCredential("token-a"),
      },
    ],
    whatsapp_templates: [
      {
        id: "tpl-1",
        organization_id: "org-a",
        whatsapp_connection_id: "conn-a",
        name: "diwali_offer",
        language: "en",
        category: over.category ?? "MARKETING",
        status: over.templateStatus ?? "APPROVED",
        body_text: "Hi {{1}}, {{2}} has 20% off this week!",
        body_param_count: 2,
      },
    ],
    whatsapp_campaigns: [
      {
        id: "camp-1",
        organization_id: "org-a",
        business_id: "biz-a",
        whatsapp_connection_id: "conn-a",
        template_id: "tpl-1",
        name: "Diwali",
        template_params: [
          { source: "contact_first_name", fallback: "there" },
          { source: "business_name" },
        ],
        max_per_minute: 20,
        ...over.campaign,
      },
    ],
    contacts: [
      { id: "ct-1", organization_id: "org-a", name: "Asha Rao", phone: "+919800000001" },
      { id: "ct-x", organization_id: "org-b", name: "Other", phone: "+919800000009" },
    ],
    whatsapp_consent_events: [
      { ...consent("919800000001", "opt_in", 100), contact_id: "ct-1" },
      consent("919800000002", "opt_in", 100),
      consent("919800000003", "opt_in", 100),
      consent("919800000003", "opt_out", 50), // changed their mind
      consent("919800000004", "opt_in", 100, "transactional"), // not marketing consent
      consent("919800000005", "opt_in", 100),
    ],
    whatsapp_suppressions: [
      {
        organization_id: "org-a",
        business_id: "biz-a",
        wa_id: "919800000005",
        reason: "invalid_number",
      },
    ],
  };
}

function fakeMeta(statuses: number[] = [200]) {
  const sent: Record<string, unknown>[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const status = statuses[Math.min(i++, statuses.length - 1)]!;
    sent.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify(status === 200 ? { messages: [{ id: `wamid.C${sent.length}` }] } : {}),
      {
        status,
      },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const launch = (db: ReturnType<typeof createFakeDb>, org = "org-a") =>
  launchCampaign(db.client, {
    organizationId: org,
    campaignId: "camp-1",
    actorUserId: "user-1",
    now: NOW,
  });
const dispatch = (db: ReturnType<typeof createFakeDb>, meta = fakeMeta(), now = NOW) =>
  dispatchWhatsAppCampaigns(db.client, {
    fetchImpl: meta.fetchImpl,
    sleep: async () => {},
    now: () => now,
  });
const recipients = (db: ReturnType<typeof createFakeDb>): Record<string, Record<string, unknown>> =>
  Object.fromEntries(db.rows("whatsapp_campaign_recipients").map((r) => [String(r["wa_id"]), r]));

describe("template helpers", () => {
  test("countBodyParams counts distinct positional parameters and flags named ones", () => {
    assert.deepEqual(countBodyParams("Hi {{1}}, see you {{2}}. {{1}}!"), {
      count: 2,
      named: false,
    });
    assert.deepEqual(countBodyParams("Hi {{name}}"), { count: 1, named: true });
    assert.deepEqual(countBodyParams(null), { count: 0, named: false });
  });

  test("notification templates must be APPROVED UTILITY templates with the right parameter count", () => {
    const ok = {
      status: "APPROVED",
      category: "UTILITY",
      body_text: "Hi {{1}} at {{2}} on {{3}}",
      body_param_count: 3,
    };
    assert.equal(templatePurposeProblem(ok, "booking_confirmed"), null);
    assert.match(
      String(templatePurposeProblem({ ...ok, status: "PENDING" }, "booking_confirmed")),
      /APPROVED/,
    );
    assert.match(
      String(templatePurposeProblem({ ...ok, category: "MARKETING" }, "booking_confirmed")),
      /UTILITY/,
    );
    assert.match(String(templatePurposeProblem(ok, "payment_link")), /1 body parameter/);
  });

  test("parameter specs: validated, then resolved per recipient", () => {
    const specs = parseParamSpecs([
      { source: "contact_first_name", fallback: "friend" },
      { source: "static", value: "20%" },
      { source: "business_name" },
    ]);
    assert.deepEqual(
      resolveParams(specs, { contactName: "Asha Rao", businessName: "Smile Dental" }),
      ["Asha", "20%", "Smile Dental"],
    );
    assert.deepEqual(resolveParams(specs, { contactName: null, businessName: "Smile Dental" }), [
      "friend",
      "20%",
      "Smile Dental",
    ]);
    assert.throws(() => parseParamSpecs([{ source: "sql", value: "x" }]), CampaignError);
    assert.throws(
      () => parseParamSpecs([{ source: "static", value: "x".repeat(501) }]),
      CampaignError,
    );
  });
});

describe("launchCampaign", () => {
  test("only numbers whose latest marketing consent is an opt-in, and not suppressed, are queued; the rest are recorded as skipped", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const result = await launch(db);
    assert.deepEqual(result, { eligible: 2, skipped: 1, status: "running" });
    const r = recipients(db);
    assert.deepEqual(Object.keys(r).sort(), ["919800000001", "919800000002", "919800000005"]);
    assert.equal(r["919800000005"]!["status"], "skipped");
    assert.equal(r["919800000005"]!["skip_reason"], "suppressed");
    assert.equal(r["919800000001"]!["contact_id"], "ct-1");
    assert.equal(db.rows("whatsapp_audit_log")[0]!["action"], "campaign.launch");
  });

  test("an explicit contact list is still filtered by consent and suppression, and never reaches another tenant's contacts", async () => {
    const s = seed({
      campaign: { audience: { type: "contacts", contactIds: ["ct-1", "ct-2", "ct-3", "ct-x"] } },
    });
    s.contacts.push(
      { id: "ct-2", organization_id: "org-a", name: "No Consent", phone: "+919800000004" },
      { id: "ct-3", organization_id: "org-a", name: "Opted Out", phone: "+919800000003" },
    );
    const db = createFakeDb(s, { now: () => NOW });
    const result = await launch(db);
    assert.deepEqual(result, { eligible: 1, skipped: 2, status: "running" });
    const r = recipients(db);
    assert.equal(r["919800000001"]!["status"], "pending");
    assert.equal(r["919800000004"]!["skip_reason"], "no_consent");
    assert.equal(r["919800000003"]!["skip_reason"], "opted_out");
    assert.equal(r["919800000009"], undefined, "org-b's contact is never even read");
  });

  test("refused for a non-marketing or unapproved template, a non-draft campaign, and another organization", async () => {
    for (const over of [{ category: "UTILITY" }, { templateStatus: "PAUSED" }]) {
      const db = createFakeDb(seed(over), { now: () => NOW });
      await assert.rejects(launch(db), (e: CampaignError) => e.code === "TEMPLATE_NOT_USABLE");
      assert.equal(db.rows("whatsapp_campaign_recipients").length, 0);
    }
    const running = createFakeDb(seed({ campaign: { status: "running" } }), { now: () => NOW });
    await assert.rejects(launch(running), (e: CampaignError) => e.code === "INVALID_STATE");
    const db = createFakeDb(seed(), { now: () => NOW });
    await assert.rejects(launch(db, "org-b"), (e: CampaignError) => e.code === "NOT_FOUND");
  });

  test("a future scheduled_at launches as 'scheduled' and starts on time", async () => {
    const db = createFakeDb(
      seed({ campaign: { scheduled_at: new Date(NOW.getTime() + 3_600_000).toISOString() } }),
      { now: () => NOW },
    );
    assert.equal((await launch(db)).status, "scheduled");
    const meta = fakeMeta();
    await dispatch(db, meta);
    assert.equal(meta.sent.length, 0);
    await dispatch(db, meta, new Date(NOW.getTime() + 2 * 3_600_000));
    assert.equal(meta.sent.length, 2);
  });
});

describe("dispatchWhatsAppCampaigns", () => {
  test("sends the approved template with per-recipient parameters, once per recipient, and completes", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    await launch(db);
    const meta = fakeMeta();
    await Promise.all([dispatch(db, meta), dispatch(db, meta)]);
    await dispatch(db, meta, new Date(NOW.getTime() + 120_000));
    assert.equal(meta.sent.length, 2);
    const asha = meta.sent.find((m) => m["to"] === "919800000001") as {
      type: string;
      template: { name: string; components: { parameters: { text: string }[] }[] };
    };
    assert.equal(asha.type, "template");
    assert.equal(asha.template.name, "diwali_offer");
    assert.deepEqual(
      asha.template.components[0]!.parameters.map((p) => p.text),
      ["Asha", "Smile Dental"],
    );
    assert.equal(db.rows("whatsapp_campaigns")[0]!["status"], "completed");
  });

  test("a STOP after launch is honoured: re-checked right before sending", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    await launch(db);
    db.rows("whatsapp_consent_events").push({
      ...consent("919800000002", "opt_out", 1),
      id: "late-stop",
    });
    const meta = fakeMeta();
    await dispatch(db, meta);
    assert.deepEqual(
      meta.sent.map((m) => m["to"]),
      ["919800000001"],
    );
    assert.equal(recipients(db)["919800000002"]!["skip_reason"], "opted_out");
  });

  test("rate limit: at most max_per_minute messages per minute", async () => {
    const s = seed({ campaign: { max_per_minute: 1 } });
    const db = createFakeDb(s, { now: () => NOW });
    await launch(db);
    const meta = fakeMeta();
    await dispatch(db, meta);
    await dispatch(db, meta, new Date(NOW.getTime() + 10_000));
    assert.equal(meta.sent.length, 1);
    await dispatch(db, meta, new Date(NOW.getTime() + 61_000));
    assert.equal(meta.sent.length, 2);
  });

  test("outside the campaign's send window nothing is sent", async () => {
    // 06:00 UTC = 11:30 in Kolkata; window 18:00–21:00.
    const db = createFakeDb(
      seed({
        campaign: {
          schedule: { windowStart: "18:00", windowEnd: "21:00", timezone: "Asia/Kolkata" },
        },
      }),
      { now: () => NOW },
    );
    await launch(db);
    const meta = fakeMeta();
    await dispatch(db, meta);
    assert.equal(meta.sent.length, 0);
    assert.equal(db.rows("whatsapp_campaigns")[0]!["status"], "running");
  });

  test("Meta 5xx: retried later, bounded; a rejection fails the recipient without retry", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    await launch(db);
    await dispatch(db, fakeMeta([503]));
    const r = recipients(db);
    assert.equal(r["919800000001"]!["status"], "pending");
    assert.equal(r["919800000001"]!["attempts"], 1);
    let t = NOW.getTime();
    for (let i = 1; i < MAX_RECIPIENT_ATTEMPTS; i++) {
      t += 60 * 60_000;
      await dispatch(db, fakeMeta([503]), new Date(t));
    }
    assert.equal(recipients(db)["919800000001"]!["status"], "failed");

    const db2 = createFakeDb(seed(), { now: () => NOW });
    await launch(db2);
    await dispatch(db2, fakeMeta([400]));
    assert.equal(recipients(db2)["919800000001"]!["status"], "failed");
  });

  test("a template paused at Meta pauses the campaign before anything is sent", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    await launch(db);
    db.rows("whatsapp_templates")[0]!["status"] = "PAUSED";
    const meta = fakeMeta();
    await dispatch(db, meta);
    assert.equal(meta.sent.length, 0);
    const c = db.rows("whatsapp_campaigns")[0]!;
    assert.equal(c["status"], "paused");
    assert.match(String(c["paused_reason"]), /PAUSED/);
    assert.equal(db.rows("whatsapp_audit_log").at(-1)!["action"], "campaign.auto_pause");
  });

  test("pause / resume / cancel follow the state machine and are audited; cancel skips what's left", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    await launch(db);
    const change = (action: "pause" | "resume" | "cancel") =>
      changeCampaignStatus(db.client, {
        organizationId: "org-a",
        campaignId: "camp-1",
        action,
        actorUserId: "user-1",
      });
    assert.deepEqual(await change("pause"), { status: "paused" });
    await assert.rejects(change("pause"), (e: CampaignError) => e.code === "INVALID_STATE");
    const meta = fakeMeta();
    await dispatch(db, meta);
    assert.equal(meta.sent.length, 0, "a paused campaign sends nothing");
    assert.deepEqual(await change("resume"), { status: "running" });
    assert.deepEqual(await change("cancel"), { status: "cancelled" });
    assert.ok(Object.values(recipients(db)).every((r) => r["status"] === "skipped"));
    await assert.rejects(
      changeCampaignStatus(db.client, {
        organizationId: "org-b",
        campaignId: "camp-1",
        action: "pause",
        actorUserId: "u",
      }),
      (e: CampaignError) => e.code === "NOT_FOUND",
    );
  });

  test("analytics: recipient outcomes plus delivery statuses from Meta's status webhooks", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    await launch(db);
    await dispatch(db, fakeMeta());
    const [m1, m2] = db.rows("whatsapp_messages").filter((m) => m["direction"] === "outbound");
    m1!["status"] = "read";
    m2!["status"] = "failed";
    const a = await campaignAnalytics(db.client, "org-a", "camp-1");
    assert.deepEqual(a, {
      total: 3,
      pending: 0,
      sent: 1,
      delivered: 1,
      read: 1,
      failed: 1,
      skipped: { suppressed: 1 },
    });
    assert.deepEqual(await campaignAnalytics(db.client, "org-b", "camp-1"), {
      total: 0,
      pending: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      skipped: {},
    });
  });
});

describe("syncTemplates", () => {
  test("reads every page from Meta, records status/category/parameters, keeps purposes, and marks deleted ones", async () => {
    const s = seed() as unknown as Record<string, Record<string, unknown>[]>;
    const templates = s["whatsapp_templates"]!;
    templates.push({
      id: "tpl-old",
      organization_id: "org-a",
      whatsapp_connection_id: "conn-a",
      name: "old_one",
      language: "en",
      category: "UTILITY",
      status: "APPROVED",
      body_text: null,
      body_param_count: 0,
    });
    const db = createFakeDb(s, { now: () => NOW });
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const page2 = url.includes("after=CURSOR");
      return new Response(
        JSON.stringify(
          page2
            ? {
                data: [
                  {
                    id: "m2",
                    name: "booking_ok",
                    language: "en",
                    status: "APPROVED",
                    category: "UTILITY",
                    components: [{ type: "BODY", text: "Hi {{1}}, {{2}} at {{3}}" }],
                  },
                ],
              }
            : {
                data: [
                  {
                    id: "m1",
                    name: "diwali_offer",
                    language: "en",
                    status: "REJECTED",
                    category: "MARKETING",
                    components: [{ type: "BODY", text: "Hi {{1}} {{2}}" }],
                  },
                ],
                paging: { cursors: { after: "CURSOR" }, next: "https://graph.facebook.com/next" },
              },
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await syncTemplates(
      db.client,
      { organizationId: "org-a", connectionId: "conn-a" },
      { fetchImpl },
    );
    assert.deepEqual(result, { synced: 2, missing: 1 });
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /\/v23\.0\/WABA_A\/message_templates\?/);
    const byName = Object.fromEntries(db.rows("whatsapp_templates").map((t) => [t["name"], t]));
    assert.equal(byName["diwali_offer"]!["status"], "REJECTED");
    assert.equal(byName["booking_ok"]!["body_param_count"], 3);
    assert.equal(byName["old_one"]!["status"], "NOT_FOUND_AT_META");
    await assert.rejects(
      syncTemplates(db.client, { organizationId: "org-b", connectionId: "conn-a" }, { fetchImpl }),
      (e: CampaignError) => e.code === "NOT_CONNECTED",
    );
  });
});
