import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The campaign report's server functions and page: who may read what, and what the page promises.
 * Source-level checks (the dashboard cannot be rendered in this suite); the numbers themselves are
 * tested in campaign-analytics.test.ts and the stored analysis in call-analysis*.test.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");
const fns = read("campaigns.functions.ts");
const section = (name: string) => {
  const start = fns.indexOf(`export const ${name}`);
  assert.ok(start > -1, name);
  const next = fns.indexOf("\nexport ", start + 10);
  return fns.slice(start, next === -1 ? undefined : next);
};

describe("the report's server functions are tenant-scoped", () => {
  for (const name of ["getCampaignAnalytics", "getCampaignCallDetail"]) {
    test(`${name} requires a signed-in member of the campaign's own workspace, read-only`, () => {
      const body = section(name);
      assert.match(body, /\.middleware\(\[requireSupabaseAuth\]\)/);
      assert.match(body, /campaignOrgId\(context, data\.campaignId, false\)/);
      assert.doesNotMatch(body, /\.update\(|\.insert\(|\.delete\(|\.rpc\(/);
    });
  }

  test("every table the report reads is filtered by the campaign AND its organization", () => {
    const body = section("getCampaignAnalytics");
    for (const table of ["campaign_contacts", "call_logs", "call_analyses", "leads"]) {
      const at = body.indexOf(`.from("${table}")`);
      assert.ok(at > -1, table);
      const chain = body.slice(at, at + 520);
      assert.match(chain, /\.eq\("campaign_id", data\.campaignId\)/, `${table} by campaign`);
      assert.match(chain, /\.eq\("organization_id", orgId\)/, `${table} by organization`);
    }
  });

  test("a call's transcript is only returned for a call of this campaign and organization", () => {
    const body = section("getCampaignCallDetail");
    assert.match(body, /\.eq\("id", data\.callId\)/);
    assert.match(body, /\.eq\("campaign_id", data\.campaignId\)/);
    assert.match(body, /\.eq\("organization_id", orgId\)/);
  });

  test("the list never carries transcripts (they are fetched one call at a time)", () => {
    const body = section("getCampaignAnalytics");
    assert.doesNotMatch(body, /transcript/);
  });

  test("a stored analysis that no longer validates is left out, not shown half-read", () => {
    assert.match(section("getCampaignAnalytics"), /CallAnalysisSchema\.safeParse/);
  });
});

describe("the report's page", () => {
  const page = read("../components/app/CampaignAnalytics.tsx");
  const route = read("../routes/app.campaigns.$campaignId.tsx");

  test("it is on the campaign page", () => {
    assert.match(route, /<CampaignAnalytics campaignId=\{campaignId\} \/>/);
  });

  test("figures without data say Unavailable instead of showing a number", () => {
    assert.match(page, /const UNAVAILABLE = "Unavailable"/);
    assert.match(page, /v === null \? UNAVAILABLE/);
    assert.match(page, /paise === null/);
  });

  test("it offers search, filter, sort, the follow-up list, appointments and a CSV download", () => {
    for (const needle of [
      "Search contacts",
      "Filter contacts",
      "Sort contacts",
      "Follow-up list",
      "Appointments and conversions",
      "Download CSV",
      "contactsToCsv",
    ])
      assert.ok(page.includes(needle), needle);
  });

  test("it covers each requested campaign metric", () => {
    for (const needle of [
      "Contacts",
      "Calls attempted",
      "Answered",
      "Conversations",
      "Average conversation",
      "Total connected time",
      "Contact success rate",
      "Conversion rate",
      "Appointments booked",
      "Appointments rescheduled",
      "Appointments cancelled",
      "Leads captured",
      "Follow-up required",
      "Do-not-call requests",
      "Campaign cost",
      "Cost per answered call",
      "Cost per interested contact",
      "Cost per successful outcome",
    ])
      assert.ok(page.includes(needle), needle);
  });

  test("each contact's report shows the requested call fields", () => {
    for (const needle of [
      "What the customer said",
      "Objections or concerns",
      "Questions asked",
      "Preferences",
      "Competitors mentioned",
      "Purchase likelihood",
      "Price sensitivity",
      "Show transcript",
      "Recording not available",
      "Extracted data",
    ])
      assert.ok(page.includes(needle), needle);
  });

  test("it says plainly when a call has not been analysed or was analysed from the result only", () => {
    assert.match(page, /has not been analysed yet/);
    assert.match(page, /Basic analysis from the call result only/);
  });
});
