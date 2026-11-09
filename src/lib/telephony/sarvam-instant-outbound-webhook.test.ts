import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SarvamTelephonyAdapter } from "./sarvam-provider.server.ts";
import {
  checkClientReferenceMatch,
  metadataOrganizationMatches,
} from "./webhook-correlation.server.ts";

/**
 * Single-call (instant outbound) webhook handling, against the payload in
 * docs.sarvam.ai/voice-agents/api/instant-outbound/webhook-payload.md:
 * attempt_id, status (connected|no_answer|busy|failed), channel_info,
 * duration, interaction_id (null unless connected), failure_reason,
 * final_agent_variables, webhook_config {url, metadata}, interaction_transcript.
 */

const adapter = new SarvamTelephonyAdapter({ outboundApiKey: "sk_test" });
const CALL_ID = "8f14e45f-ceea-467e-a4a9-1c1c1c1c1c1c";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: "att_123",
    status: "connected",
    channel_info: {
      channel_type: "v2v",
      channel_provider: "vobiz",
      agent_phone_number: "+918047168000",
    },
    duration: 61,
    interaction_id: "20261109/int_1",
    failure_reason: null,
    final_agent_variables: { booked: "yes" },
    webhook_config: {
      url: "https://clickai.in/api/public/webhooks/telephony?provider=sarvam",
      metadata: { organization_id: "org_1", call_id: CALL_ID },
    },
    interaction_transcript: [{ role: "agent", en_text: "Hello" }],
    ...overrides,
  };
}
const normalize = (p: unknown) => adapter.normalizeWebhookEvent(JSON.stringify(p));

describe("single-call status mapping", () => {
  for (const [status, expected] of [
    ["connected", "completed"],
    ["no_answer", "no_answer"],
    ["busy", "busy"],
    ["failed", "failed"],
  ] as const) {
    test(`${status} -> ${expected}, keyed by attempt_id`, () => {
      const unanswered = status !== "connected";
      const e = normalize(
        payload({
          status,
          interaction_id: unanswered ? null : "20261109/int_1",
          duration: unanswered ? null : 61,
          failure_reason:
            status === "failed" ? "exotel: Phone number is registered under TRAI NDNC" : null,
        }),
      )!;
      assert.ok(e, "event must not be dropped");
      assert.equal(e.status, expected);
      assert.equal(e.direction, "outbound");
      assert.equal(e.providerCallId, "att_123");
      assert.equal(e.eventId, "att_123");
      assert.equal(e.providerAttemptId, "att_123");
      if (status === "failed") assert.match(e.failureReason!, /NDNC/);
    });
  }

  test("a null interaction_id no longer drops the event", () => {
    const e = normalize(payload({ status: "no_answer", interaction_id: null }));
    assert.ok(e);
    assert.equal(e!.providerCallId, "att_123");
  });

  test("an undocumented status value is rejected, never guessed", () => {
    assert.equal(normalize(payload({ status: "voicemail" })), null);
  });

  test("connected call keeps duration, transcript, from-number and agent variables", () => {
    const e = normalize(payload())!;
    assert.equal(e.durationSeconds, 61);
    assert.equal(e.fromE164, "+918047168000");
    assert.equal(e.transcript?.[0]?.text, "Hello");
    assert.deepEqual(e.agentVariables, { final: { booked: "yes" } });
  });
});

describe("billing: only a connected single call carries billable duration", () => {
  // The route bills `finalizeCallBilling(call, event.durationSeconds ?? 0)` for every
  // terminal status, so a missing duration is what keeps a call at 0 billable minutes.
  for (const [status, expected] of [
    ["connected", 45],
    ["no_answer", undefined],
    ["busy", undefined],
    ["failed", undefined],
  ] as const) {
    test(`${status} with a reported duration of 45s -> durationSeconds ${expected}`, () => {
      const e = normalize(payload({ status, duration: 45 }))!;
      assert.equal(e.durationSeconds, expected);
    });
  }

  test("the route passes event.durationSeconds (defaulting to 0) to finalizeCallBilling", () => {
    const route = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../routes/api/public/webhooks/telephony.ts",
      ),
      "utf8",
    ).replace(/\r\n/g, "\n");
    assert.match(
      route,
      /finalizeCallBilling\(\s*\{[^}]*\},\s*event\.durationSeconds \?\? 0,?\s*\)/,
    );
  });
});

describe("metadata matching", () => {
  test("reads webhook_config.metadata: call_id becomes clientReference, organization_id is surfaced", () => {
    const e = normalize(payload())!;
    assert.equal(e.clientReference, CALL_ID);
    assert.equal(e.metadataOrganizationId, "org_1");
  });

  test("call_id is preferred over campaign_contact_id (only call_logs ids are resolvable)", () => {
    const e = normalize(
      payload({
        webhook_config: {
          url: "x",
          metadata: { organization_id: "org_1", campaign_contact_id: "cc_1", call_id: CALL_ID },
        },
      }),
    )!;
    assert.equal(e.clientReference, CALL_ID);
  });

  test("campaign webhooks (top-level metadata, completion_status) keep their existing path", () => {
    const e = normalize({
      attempt_id: "att_9",
      campaign_id: "camp_1",
      completion_status: "completed",
      connectivity_status: "connected",
      interaction_id: "int_9",
      user_phone_number: "+919876543210",
      metadata: { organization_id: "org_2", call_id: CALL_ID },
    })!;
    assert.equal(e.providerCallId, "int_9");
    assert.equal(e.status, "completed");
    assert.equal(e.metadataOrganizationId, "org_2");
  });
});

describe("duplicate deliveries and mismatched organizations", () => {
  test("the same delivery twice yields the same event id (webhook_events dedupe key)", () => {
    const a = normalize(payload())!;
    const b = normalize(payload())!;
    assert.equal(a.eventId, b.eventId);
    assert.equal(a.providerCallId, b.providerCallId);
  });

  test("metadataOrganizationMatches: equal or absent passes, different fails", () => {
    assert.equal(metadataOrganizationMatches({ metadataOrganizationId: "org_1" }, "org_1"), true);
    assert.equal(metadataOrganizationMatches({ metadataOrganizationId: undefined }, "org_1"), true);
    assert.equal(
      metadataOrganizationMatches({ metadataOrganizationId: "org_evil" }, "org_1"),
      false,
    );
  });

  const route = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../routes/api/public/webhooks/telephony.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  test("checkClientReferenceMatch: a row bound to attempt A rejects attempt B", () => {
    const row = { organization_id: "org_1", provider_call_id: "att_A" };
    assert.deepEqual(
      checkClientReferenceMatch(row, { metadataOrganizationId: "org_1", providerCallId: "att_B" }),
      { ok: false, reason: "provider_call_id_mismatch" },
    );
  });

  test("checkClientReferenceMatch: a row with no provider_call_id is matched and backfilled", () => {
    const row = { organization_id: "org_1", provider_call_id: null };
    assert.deepEqual(
      checkClientReferenceMatch(row, { metadataOrganizationId: "org_1", providerCallId: "att_B" }),
      { ok: true, backfillProviderCallId: true },
    );
  });

  test("checkClientReferenceMatch: the same attempt id is matched without a backfill", () => {
    const row = { organization_id: "org_1", provider_call_id: "att_B" };
    assert.deepEqual(
      checkClientReferenceMatch(row, {
        metadataOrganizationId: undefined,
        providerCallId: "att_B",
      }),
      { ok: true, backfillProviderCallId: false },
    );
  });

  test("checkClientReferenceMatch: organization mismatch is still rejected, even on an empty row", () => {
    const row = { organization_id: "org_1", provider_call_id: null };
    assert.deepEqual(
      checkClientReferenceMatch(row, {
        metadataOrganizationId: "org_evil",
        providerCallId: "att_B",
      }),
      { ok: false, reason: "organization_mismatch" },
    );
  });

  test("route: existing-row path checks the organization before applyCallEvent", () => {
    const at = route.indexOf("metadataOrganizationMatches(event, existingCall.organization_id)");
    assert.ok(at > -1);
    assert.ok(route.indexOf("return;", at) < route.indexOf("applyCallEvent(", at));
  });

  test("route: a rejected call_id match returns before any write, status change, billing or campaign update", () => {
    const branch = route.slice(
      route.indexOf('if (event.direction === "outbound") {'),
      route.indexOf("const destinationNumber ="),
    );
    const check = branch.indexOf("const match = checkClientReferenceMatch(resolved, event);");
    const reject = branch.indexOf("if (!match.ok) {", check);
    const rejectReturn = branch.indexOf("return;", reject);
    assert.ok(check > -1 && reject > check);
    // applyCallEvent is the only path to status/duration updates, finalizeCallBilling
    // and applyCampaignTerminalEvent; the backfill .update( is the only other write.
    assert.ok(rejectReturn < branch.indexOf(".update(", check));
    assert.ok(rejectReturn < branch.indexOf("applyCallEvent(", check));
    assert.match(branch, /if \(match\.backfillProviderCallId\) \{/);
    assert.match(branch, /\.is\("provider_call_id", null\)/);
  });

  test("route dedupes on webhook_events before any processing, and replays are no-ops", () => {
    const dedupe = route.indexOf('from("webhook_events").insert(');
    const process = route.indexOf("await processTelephonyEvent(");
    assert.ok(dedupe > -1 && dedupe < process);
    assert.match(route, /code === "23505"\) return new Response\("ok \(duplicate\)"\)/);
    assert.match(route, /if \(!transition\.changed\) return; \/\/ idempotent replay/);
  });
});

test("campaign dispatcher sends call_id and stores only attempt_id as provider_call_id", () => {
  const dispatch = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../campaign-dispatch.server.ts"),
    "utf8",
  );
  assert.match(dispatch, /callId: call\.id/);
  assert.match(
    dispatch,
    /if \(result\.attemptId\) patch\["provider_call_id"\] = result\.attemptId;/,
  );
  assert.match(
    dispatch,
    /patch\["provider_metadata"\] = \{ interaction_id: result\.interactionId \}/,
  );
  assert.doesNotMatch(dispatch, /attemptId \?\? result\.interactionId/);
});
