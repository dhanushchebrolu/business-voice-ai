import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  VobizApiError,
  VobizWhatsAppClient,
  parseAvailableNumbers,
  parseTemplates,
} from "./vobiz-whatsapp-client.server.ts";

/**
 * MOCKED: no request here reaches Vobiz. A scripted fetch answers with the
 * response shapes Vobiz documents (vobiz-ai/vobiz-mcp-server
 * skills/vobiz-whatsapp/SKILL.md and the Channels/Numbers API pages); these
 * tests pin ClickAI's side of that contract — URL, headers, body, parsing,
 * error handling — not Vobiz's behaviour.
 */

const AUTH_ID = "MA_TESTAUTHID";
const AUTH_TOKEN = "vobiz-test-token-do-not-log";
const META_TOKEN = "EAAtestSystemUserTokenValue1234567890";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fake(responses: (number | { status: number; body: unknown } | "timeout" | "network")[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r === "network") throw new TypeError("fetch failed");
    if (r === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    const { status, body } = typeof r === "number" ? { status: r, body: {} } : r;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const client = new VobizWhatsAppClient({ authId: AUTH_ID, authToken: AUTH_TOKEN, fetchImpl });
  return { client, calls };
}

const CHANNEL = {
  id: "8f6b0c1e-1111-4a5b-9c2d-000000000001",
  waba_id: "102030405060708",
  phone_number_id: "109876543210987",
  phone_number: "+919876543210",
  number_onboarding_mode: "bring_your_own",
  number_order_id: null,
};

describe("requests", () => {
  test("every request goes to /api/v1/messaging with X-Auth-ID/X-Auth-Token headers", async () => {
    const { client, calls } = fake([{ status: 201, body: CHANNEL }]);
    await client.completeEmbeddedSignup({ code: "AQB-code", wabaId: "102030405060708" });
    assert.equal(
      calls[0]!.url,
      "https://api.vobiz.ai/api/v1/messaging/channels/whatsapp/embedded-signup",
    );
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["X-Auth-ID"], AUTH_ID);
    assert.equal(calls[0]!.headers["X-Auth-Token"], AUTH_TOKEN);
    assert.deepEqual(calls[0]!.body, { code: "AQB-code", waba_id: "102030405060708" });
  });

  test("a custom VOBIZ_BASE_URL (with or without a trailing slash) is respected", async () => {
    const calls: string[] = [];
    const client = new VobizWhatsAppClient({
      authId: AUTH_ID,
      authToken: AUTH_TOKEN,
      baseUrl: "https://sandbox.vobiz.example/api/v1/",
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify([]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.listChannels();
    assert.equal(calls[0], "https://sandbox.vobiz.example/api/v1/messaging/channels/whatsapp");
  });

  test("BYON: verify, confirm and create-channel bodies use Vobiz's documented fields", async () => {
    const { client, calls } = fake([200, 200, { status: 201, body: CHANNEL }]);
    await client.startByonVerification({ phoneNumber: "+919876543210", method: "sms" });
    await client.confirmByonVerification({ phoneNumber: "+919876543210", otpCode: "123456" });
    const channel = await client.createChannel({
      mode: "bring_your_own",
      wabaId: "102030405060708",
      phoneNumberId: "109876543210987",
      phoneNumber: "+919876543210",
      accessToken: META_TOKEN,
      displayName: "Smile Dental",
    });
    assert.deepEqual(
      calls.map((c) => c.url.replace("https://api.vobiz.ai/api/v1/messaging", "")),
      [
        "/numbers/whatsapp/bring-your-own/verify",
        "/numbers/whatsapp/bring-your-own/confirm",
        "/channels/whatsapp",
      ],
    );
    assert.deepEqual(calls[0]!.body, { phone_number: "+919876543210", verification_method: "sms" });
    assert.deepEqual(calls[1]!.body, { phone_number: "+919876543210", otp_code: "123456" });
    assert.deepEqual(calls[2]!.body, {
      number_onboarding_mode: "bring_your_own",
      waba_id: "102030405060708",
      phone_number_id: "109876543210987",
      phone_number: "+919876543210",
      number_provider: "meta_direct",
      access_token: META_TOKEN,
      display_name: "Smile Dental",
    });
    assert.equal(channel.id, CHANNEL.id);
    assert.equal(channel.phoneNumberId, CHANNEL.phone_number_id);
  });

  test("buy: order body, order parsing, and buy_from_vobiz channel body (no phone_number_id)", async () => {
    const { client, calls } = fake([
      {
        status: 201,
        body: {
          id: "0a0b0c0d-2222-4a5b-9c2d-000000000002",
          status: "pending",
          selected_phone_number: "+918000000001",
          failure_reason: null,
        },
      },
      { status: 201, body: { ...CHANNEL, number_onboarding_mode: "buy_from_vobiz" } },
    ]);
    const order = await client.createNumberOrder({ phoneNumber: "+918000000001" });
    assert.deepEqual(order, {
      id: "0a0b0c0d-2222-4a5b-9c2d-000000000002",
      status: "pending",
      selectedPhoneNumber: "+918000000001",
      failureReason: null,
    });
    assert.deepEqual(calls[0]!.body, { phone_number: "+918000000001" });
    await client.createChannel({
      mode: "buy_from_vobiz",
      wabaId: "102030405060708",
      numberOrderId: order.id,
      phoneNumber: "+918000000001",
    });
    assert.deepEqual(calls[1]!.body, {
      number_onboarding_mode: "buy_from_vobiz",
      waba_id: "102030405060708",
      number_order_id: order.id,
      phone_number: "+918000000001",
    });
  });

  test("send text: channel_id, waba_id, +E.164 `to`, text.body; returns id and the wamid", async () => {
    const { client, calls } = fake([
      { status: 201, body: { id: "msg-uuid", status: "pending", meta_message_id: "wamid.ABC" } },
    ]);
    const sent = await client.sendMessage({
      channelId: CHANNEL.id,
      wabaId: CHANNEL.waba_id,
      to: "919876543210",
      payload: { kind: "text", body: "Hi!" },
    });
    assert.equal(calls[0]!.url, "https://api.vobiz.ai/api/v1/messaging/messages");
    assert.deepEqual(calls[0]!.body, {
      channel_id: CHANNEL.id,
      waba_id: CHANNEL.waba_id,
      to: "+919876543210",
      type: "text",
      text: { body: "Hi!" },
    });
    assert.deepEqual(sent, { id: "msg-uuid", status: "pending", metaMessageId: "wamid.ABC" });
  });

  test("send template: template.name, template.language.code and ordered body parameters", async () => {
    const { client, calls } = fake([
      { status: 201, body: { id: "msg-2", status: "pending", meta_message_id: null } },
    ]);
    const sent = await client.sendMessage({
      channelId: CHANNEL.id,
      wabaId: CHANNEL.waba_id,
      to: "+919876543210",
      payload: {
        kind: "template",
        name: "booking_confirmed",
        languageCode: "en_US",
        bodyParams: ["Asha", "Smile Dental", "Mon 10:00"],
      },
    });
    assert.deepEqual(calls[0]!.body, {
      channel_id: CHANNEL.id,
      waba_id: CHANNEL.waba_id,
      to: "+919876543210",
      type: "template",
      template: {
        name: "booking_confirmed",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Asha" },
              { type: "text", text: "Smile Dental" },
              { type: "text", text: "Mon 10:00" },
            ],
          },
        ],
      },
    });
    assert.equal(sent.metaMessageId, null, "the wamid can be null until Meta accepts");
  });
});

describe("errors", () => {
  test("a 2xx without a message id is an unknown outcome, never a success", async () => {
    const { client } = fake([{ status: 201, body: { status: "pending" } }]);
    await assert.rejects(
      client.sendMessage({
        channelId: "c",
        wabaId: "w",
        to: "+911234567",
        payload: { kind: "text", body: "x" },
      }),
      (e: unknown) => e instanceof VobizApiError && e.kind === "invalid_response",
    );
  });

  test("timeouts, network failures, 429/5xx and rejections are distinguished", async () => {
    const cases: [Parameters<typeof fake>[0][number], (e: VobizApiError) => void][] = [
      ["timeout", (e) => assert.equal(e.kind, "timeout")],
      ["network", (e) => assert.equal(e.kind, "network")],
      [429, (e) => assert.ok(e.isRetryable && !e.isRejection)],
      [503, (e) => assert.ok(e.isRetryable && !e.isRejection)],
      [400, (e) => assert.ok(e.isRejection && !e.isRetryable)],
      [401, (e) => assert.match(e.message, /credentials/)],
    ];
    for (const [response, check] of cases) {
      const { client } = fake([response]);
      await assert.rejects(client.listChannels(), (e: unknown) => {
        assert.ok(e instanceof VobizApiError);
        check(e);
        return true;
      });
    }
  });

  test("Vobiz's own error message is surfaced, but never a token, ClickAI credential or the Meta token", async () => {
    const { client } = fake([
      { status: 422, body: { error: { message: `Invalid access_token ${META_TOKEN}` } } },
    ]);
    await assert.rejects(
      client.createChannel({
        mode: "bring_your_own",
        wabaId: "1",
        phoneNumberId: "2",
        phoneNumber: "+911234567",
        accessToken: META_TOKEN,
      }),
      (e: unknown) => {
        assert.ok(e instanceof VobizApiError);
        assert.match(e.message, /Invalid access_token \[redacted\]/);
        for (const secret of [META_TOKEN, AUTH_TOKEN, AUTH_ID])
          assert.ok(!e.message.includes(secret));
        return true;
      },
    );
  });

  test("an unexpected channel or order body is an error, not an assumed success", async () => {
    for (const body of [{}, { channel: { name: "x" } }, null, []]) {
      const { client } = fake([{ status: 201, body }]);
      await assert.rejects(
        client.completeEmbeddedSignup({ code: "c", wabaId: "w" }),
        /unexpected channel/,
      );
    }
    const { client } = fake([{ status: 201, body: { id: "x" } }]);
    await assert.rejects(
      client.createNumberOrder({ phoneNumber: "+911234567" }),
      /unexpected order/,
    );
  });
});

describe("defensive parsing of responses not seen in full", () => {
  test("available numbers: any E.164 string in the items, normalised with a leading +", () => {
    assert.deepEqual(
      parseAvailableNumbers({
        data: [
          { phone_number: "+918000000001", region: "KA" },
          { number: "918000000002" },
          { foo: "bar" },
        ],
      }),
      ["+918000000001", "+918000000002"],
    );
    assert.deepEqual(parseAvailableNumbers({ unexpected: true }), []);
  });

  test("templates: complete rows are kept, incomplete rows are counted as skipped", () => {
    const { templates, skipped } = parseTemplates({
      data: [
        {
          id: "t1",
          name: "booking_confirmed",
          language: "en_US",
          category: "utility",
          status: "approved",
          components: [{ type: "BODY", text: "Hi {{1}}, see you at {{2}} on {{3}}." }],
        },
        { name: "no_status", language: { code: "en" }, category: "UTILITY" },
      ],
    });
    assert.equal(skipped, 1);
    assert.deepEqual(templates, [
      {
        id: "t1",
        name: "booking_confirmed",
        language: "en_US",
        category: "UTILITY",
        status: "APPROVED",
        bodyText: "Hi {{1}}, see you at {{2}} on {{3}}.",
      },
    ]);
  });
});
