import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  INBOUND_RETAINED_VARIABLES,
  OUTBOUND_RETAINED_VARIABLES,
  LEAD_NOTE_VARIABLES,
  finalCallVariables,
  leadNotesFromVariables,
  retainCallVariables,
} from "./call-variables.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";

/**
 * What ClickAI keeps of a call's final agent variables, checked against the
 * real Sarvam webhook parser's output (grouped as { initial, final, output }).
 */

const adapter = new SarvamTelephonyAdapter({ inboundApiKey: "sk_in", outboundApiKey: "sk_out" });

// What Smile Dental's agent ends a call with: its own context plus the outcome fields.
const AGENT_FINAL = {
  business_name: "Smile Dental",
  business_description: "A modern dental clinic …",
  faqs: "Q: Do you offer EMI? …",
  policies: "Never diagnose over the phone.",
  services_and_prices: "Root Canal Treatment: ₹5000",
  business_email: "clinic@example.com",
  greeting: "Thanks for calling",
  userName: "Divya Nair",
  call_disposition: "callback_requested",
  call_outcome: "callback_requested",
  call_summary: "Asked for a root canal callback.",
  customer_name: "Asha",
  caller_interest: "root canal",
  requested_slot: "2026-11-19 10:00",
  opted_out: "no",
  interest_level: "high",
  do_not_call: "no",
  wrong_number: "no",
  outbound_result: "interested",
  clickai_call_id: "call_1",
  campaign_objective: "Remind about check-ups",
};

describe("stored call variables", () => {
  test("inbound keeps exactly the six outcome fields, flattened from the parser's groups", () => {
    const event = adapter.normalizeWebhookEvent(
      JSON.stringify({
        app_id: "app_1",
        app_version: "6",
        deployment_id: "dep_1",
        interaction_id: "20261118/in_1",
        user_phone_number: "+919876543210",
        agent_phone_number: "+917900000061",
        duration: 42,
        final_agent_variables: AGENT_FINAL,
        output_agent_variables: { call_outcome: "callback_requested" },
        start_datetime: "2026-11-18T10:00:00Z",
        end_datetime: "2026-11-18T10:00:42Z",
      }),
    );
    assert.ok(event?.agentVariables && "final" in event.agentVariables, "the parser groups them");
    const kept = retainCallVariables(event!.agentVariables, "inbound");
    assert.deepEqual(Object.keys(kept!).sort(), [...INBOUND_RETAINED_VARIABLES].sort());
    assert.deepEqual(kept, {
      call_outcome: "callback_requested",
      call_summary: "Asked for a root canal callback.",
      customer_name: "Asha",
      caller_interest: "root canal",
      requested_slot: "2026-11-19 10:00",
      opted_out: "no",
    });
  });

  test("outbound keeps the six plus interest_level, do_not_call and wrong_number", () => {
    const event = adapter.normalizeWebhookEvent(
      JSON.stringify({
        attempt_id: "att_1",
        status: "connected",
        channel_info: { channel_type: "v2v", agent_phone_number: "+917900000061" },
        duration: 61,
        interaction_id: "20261118/out_1",
        final_agent_variables: AGENT_FINAL,
        webhook_config: {
          url: "https://clickai.test/api/public/webhooks/telephony?provider=sarvam",
          metadata: { organization_id: "org_1", call_id: "8f14e45f-ceea-467e-a4a9-1c1c1c1c1c1c" },
        },
      }),
    );
    const kept = retainCallVariables(event!.agentVariables, "outbound");
    assert.deepEqual(Object.keys(kept!).sort(), [...OUTBOUND_RETAINED_VARIABLES].sort());
    assert.equal(kept!["interest_level"], "high");
    assert.equal(kept!["do_not_call"], "no");
    assert.equal(kept!["wrong_number"], "no");
  });

  test("final wins over output; output fills a missing name; call-start inputs are not outcomes", () => {
    assert.deepEqual(
      finalCallVariables({
        initial: { call_direction: "outbound", opted_out: "yes" },
        final: { call_outcome: "booked" },
        output: { call_outcome: "other", opted_out: "no" },
      }),
      { call_outcome: "booked", opted_out: "no" },
    );
    // Already flat (what ClickAI stores now, or another provider): unchanged.
    assert.deepEqual(finalCallVariables({ opted_out: "yes" }), { opted_out: "yes" });
    assert.equal(finalCallVariables(null), null);
    assert.equal(finalCallVariables("x"), null);
  });

  test("only scalar values survive, long text is capped, nothing kept means null", () => {
    const kept = retainCallVariables(
      {
        call_summary: "x".repeat(5000),
        customer_name: { first: "Asha" },
        opted_out: true,
        caller_interest: ["root canal"],
      },
      "inbound",
    );
    assert.deepEqual(Object.keys(kept!).sort(), ["call_summary", "opted_out"]);
    assert.equal((kept!["call_summary"] as string).length, 2000);
    assert.equal(retainCallVariables({ business_name: "Smile Dental" }, "inbound"), null);
    assert.equal(retainCallVariables(undefined, "outbound"), null);
  });

  test("everything the outcome, lead and opt-out paths read is retained", () => {
    // sarvam-agent-api recordCallOutcome (via reconciliation), lead creation and opt-out.
    for (const name of [
      "call_outcome",
      "call_summary",
      "customer_name",
      "caller_interest",
      "requested_slot",
      "opted_out",
    ])
      assert.ok((INBOUND_RETAINED_VARIABLES as readonly string[]).includes(name), name);
    // campaign-outcome.detectSpecialOutcome and call-finalization's lead score.
    for (const name of [
      "opted_out",
      "do_not_call",
      "wrong_number",
      "call_outcome",
      "interest_level",
    ])
      assert.ok((OUTBOUND_RETAINED_VARIABLES as readonly string[]).includes(name), name);
  });
});

describe("campaign lead notes", () => {
  test("contain only the call's result fields, never the agent's context or opt-out flags", () => {
    const notes = leadNotesFromVariables({ final: AGENT_FINAL });
    const parsed = JSON.parse(notes!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), [...LEAD_NOTE_VARIABLES].sort());
    for (const forbidden of [
      "business_description",
      "faqs",
      "policies",
      "business_email",
      "userName",
      "opted_out",
      "do_not_call",
      "wrong_number",
      "campaign_objective",
      "clickai_call_id",
    ])
      assert.ok(!notes!.includes(forbidden), forbidden);
    assert.equal(leadNotesFromVariables({ business_name: "Smile Dental" }), null);
  });
});
