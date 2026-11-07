import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BYON_OTP_REQUESTS_PER_HOUR,
  WhatsAppOnboardingError,
  completeEmbeddedSignup,
  connectByon,
  connectPurchasedNumber,
  orderNumber,
  reconnectConnection,
  startByonVerification,
} from "./whatsapp-vobiz-onboarding.server.ts";
import { VobizApiError, type VobizChannel } from "./vobiz-whatsapp-client.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

/**
 * MOCKED provider: Vobiz is a scripted stand-in (no network). The ClickAI
 * side runs for real against the in-memory database (whatsapp-test-db.ts),
 * which mirrors the real unique constraints. Real-Vobiz behaviour (which
 * fields it returns, when an order completes) is not proven here.
 */

const ORG = "org-a";
const OTHER_ORG = "org-b";
const SCOPE = { organizationId: ORG, businessId: "biz-a", connectionId: null };
const META_TOKEN = "EAAsystemUserTokenForTests0123456789";
const PHONE = "+919876543210";
const PN_ID = "109876543210987";
const WABA = "102030405060708";

type Script = Partial<Record<string, ((...args: unknown[]) => unknown) | Error>>;

function fakeVobiz(script: Script = {}, channels: VobizChannel[] = []) {
  const calls: { method: string; args: unknown }[] = [];
  const channel = (over: Partial<VobizChannel> = {}): VobizChannel => ({
    id: "ch-1",
    wabaId: WABA,
    phoneNumberId: PN_ID,
    phoneNumber: PHONE,
    displayName: null,
    numberOnboardingMode: "bring_your_own",
    numberOrderId: null,
    ...over,
  });
  const run = async (method: string, args: unknown, fallback: () => unknown) => {
    calls.push({ method, args });
    const s = script[method];
    if (s instanceof Error) throw s;
    return s ? s(args) : fallback();
  };
  const vobiz = {
    startByonVerification: (a: unknown) => run("startByonVerification", a, () => undefined),
    confirmByonVerification: (a: unknown) => run("confirmByonVerification", a, () => undefined),
    createChannel: (a: unknown) => run("createChannel", a, () => channel()),
    completeEmbeddedSignup: (a: unknown) =>
      run("completeEmbeddedSignup", a, () => channel({ numberOnboardingMode: "embedded_signup" })),
    listChannels: () => run("listChannels", undefined, () => channels),
    searchAvailableNumbers: (a: unknown) =>
      run("searchAvailableNumbers", a, () => ["+918000000001"]),
    createNumberOrder: (a: unknown) =>
      run("createNumberOrder", a, () => ({
        id: "vobiz-order-1",
        status: "pending",
        selectedPhoneNumber: "+918000000001",
        failureReason: null,
      })),
  } as never;
  return { vobiz, calls, channel };
}

function world(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createFakeDb({
    whatsapp_connections: [],
    whatsapp_number_orders: [],
    customer_events: [],
    ...extra,
  });
}

const byonInput = {
  phoneNumber: PHONE,
  otpCode: "123456",
  wabaId: WABA,
  phoneNumberId: PN_ID,
  accessToken: META_TOKEN,
  displayName: "Smile Dental",
};

async function rejectsCode(p: Promise<unknown>, code: WhatsAppOnboardingError["code"]) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof WhatsAppOnboardingError, String(e));
    assert.equal(e.code, code);
    return true;
  });
}

describe("1. Bring your own number", () => {
  test("verify → confirm → create channel → connection saved for this organization; the Meta token is never stored", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    await startByonVerification(
      db.client,
      SCOPE,
      { phoneNumber: "+91 98765-43210", method: "sms" },
      { vobiz },
    );
    const result = await connectByon(db.client, SCOPE, byonInput, { vobiz });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["startByonVerification", "confirmByonVerification", "createChannel"],
    );
    assert.deepEqual(calls[0]!.args, { phoneNumber: PHONE, method: "sms" });
    assert.equal(result.alreadyConnected, false);
    const [row] = db.rows("whatsapp_connections");
    assert.equal(row!["organization_id"], ORG);
    assert.equal(row!["business_id"], "biz-a");
    assert.equal(row!["provider"], "vobiz");
    assert.equal(row!["vobiz_channel_id"], "ch-1");
    assert.equal(row!["phone_number_id"], PN_ID);
    assert.equal(row!["number_onboarding_mode"], "bring_your_own");
    assert.equal(row!["status"], "connected");
    assert.equal(row!["access_token_ciphertext"], null);
    assert.ok(!JSON.stringify(db.rows("whatsapp_connections")).includes(META_TOKEN));
    assert.ok(!JSON.stringify(db.rows("customer_events")).includes(META_TOKEN));
  });

  test("a repeat after success is idempotent: no second OTP check or channel", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    await connectByon(db.client, SCOPE, byonInput, { vobiz });
    const again = await connectByon(db.client, SCOPE, byonInput, { vobiz });
    assert.equal(again.alreadyConnected, true);
    assert.equal(calls.filter((c) => c.method === "createChannel").length, 1);
    assert.equal(db.rows("whatsapp_connections").length, 1);
  });

  test("a number live for another organization is refused before Vobiz is called", async () => {
    const db = world({
      whatsapp_connections: [
        {
          id: "x",
          organization_id: OTHER_ORG,
          waba_id: "1",
          phone_number_id: PN_ID,
          status: "connected",
        },
      ],
    });
    const { vobiz, calls } = fakeVobiz();
    await rejectsCode(
      connectByon(db.client, SCOPE, byonInput, { vobiz }),
      "duplicate_phone_number",
    );
    assert.equal(calls.length, 0);
  });

  test("invalid input is refused before Vobiz is called", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    for (const bad of [
      { phoneNumber: "12345" },
      { wabaId: "abc" },
      { phoneNumberId: "" },
      { otpCode: "12" },
      { accessToken: "not-a-meta-token" },
    ]) {
      await rejectsCode(
        connectByon(db.client, SCOPE, { ...byonInput, ...bad }, { vobiz }),
        "invalid_input",
      );
    }
    assert.equal(calls.length, 0);
  });

  test("a wrong OTP is Vobiz's rejection: nothing is created or saved", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz({
      confirmByonVerification: new VobizApiError("Vobiz: Invalid OTP", "http", 400),
    });
    await rejectsCode(connectByon(db.client, SCOPE, byonInput, { vobiz }), "provider_rejected");
    assert.ok(!calls.some((c) => c.method === "createChannel"));
    assert.equal(db.rows("whatsapp_connections").length, 0);
  });

  test("a lost create-channel response is recovered from Vobiz's channel list (no second channel)", async () => {
    const db = world();
    const { vobiz, calls, channel } = fakeVobiz(
      { createChannel: new VobizApiError("Vobiz did not respond in time.", "timeout") },
      [],
    );
    // The channel exists at Vobiz although the response was lost.
    (vobiz as { listChannels: () => Promise<VobizChannel[]> }).listChannels = async () => {
      calls.push({ method: "listChannels", args: undefined });
      return [channel({ id: "ch-recovered" })];
    };
    const result = await connectByon(db.client, SCOPE, byonInput, { vobiz });
    assert.equal(db.rows("whatsapp_connections")[0]!["vobiz_channel_id"], "ch-recovered");
    assert.equal(result.alreadyConnected, false);
    assert.equal(calls.filter((c) => c.method === "createChannel").length, 1);
  });

  test("a lost response with no channel at Vobiz is a retryable error, not a fake success", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({ createChannel: new VobizApiError("x", "network") }, []);
    await rejectsCode(connectByon(db.client, SCOPE, byonInput, { vobiz }), "provider_unavailable");
    assert.equal(db.rows("whatsapp_connections").length, 0);
  });

  test(`OTP requests are limited to ${BYON_OTP_REQUESTS_PER_HOUR} per organization per hour`, async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    for (let i = 0; i < BYON_OTP_REQUESTS_PER_HOUR; i++) {
      await startByonVerification(
        db.client,
        SCOPE,
        { phoneNumber: PHONE, method: "voice" },
        { vobiz },
      );
    }
    await rejectsCode(
      startByonVerification(db.client, SCOPE, { phoneNumber: PHONE, method: "sms" }, { vobiz }),
      "rate_limited",
    );
    assert.equal(calls.length, BYON_OTP_REQUESTS_PER_HOUR);
    // Another organization has its own allowance.
    await startByonVerification(
      db.client,
      { ...SCOPE, organizationId: OTHER_ORG },
      { phoneNumber: PHONE, method: "sms" },
      { vobiz },
    );
  });
});

describe("2. Buy a number through Vobiz", () => {
  test("ordering writes the purchase lock first; a repeat never buys twice", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    const first = await orderNumber(
      db.client,
      SCOPE,
      { phoneNumber: "+918000000001", requestedBy: "u1" },
      { vobiz },
    );
    assert.equal(first.status, "pending");
    assert.equal(first.alreadyOrdered, false);
    const second = await orderNumber(
      db.client,
      SCOPE,
      { phoneNumber: "+918000000001", requestedBy: "u2" },
      { vobiz },
    );
    assert.equal(second.alreadyOrdered, true);
    assert.equal(second.id, first.id);
    assert.equal(calls.filter((c) => c.method === "createNumberOrder").length, 1);
    assert.equal(db.rows("whatsapp_number_orders")[0]!["vobiz_order_id"], "vobiz-order-1");
  });

  test("a Vobiz rejection marks the order failed (lock released for a new attempt)", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({
      createNumberOrder: new VobizApiError("Vobiz: Number unavailable", "http", 422),
    });
    await rejectsCode(
      orderNumber(db.client, SCOPE, { phoneNumber: "+918000000001", requestedBy: "u1" }, { vobiz }),
      "provider_rejected",
    );
    assert.equal(db.rows("whatsapp_number_orders")[0]!["status"], "failed");
    const ok = fakeVobiz();
    const retry = await orderNumber(
      db.client,
      SCOPE,
      { phoneNumber: "+918000000001", requestedBy: "u1" },
      { vobiz: ok.vobiz },
    );
    assert.equal(retry.status, "pending");
  });

  test("no response: the order is 'unknown' and a repeat does NOT buy again", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz({ createNumberOrder: new VobizApiError("x", "timeout") });
    await rejectsCode(
      orderNumber(db.client, SCOPE, { phoneNumber: "+918000000001", requestedBy: "u1" }, { vobiz }),
      "provider_unavailable",
    );
    assert.equal(db.rows("whatsapp_number_orders")[0]!["status"], "unknown");
    const again = await orderNumber(
      db.client,
      SCOPE,
      { phoneNumber: "+918000000001", requestedBy: "u1" },
      { vobiz },
    );
    assert.equal(again.alreadyOrdered, true);
    assert.equal(calls.filter((c) => c.method === "createNumberOrder").length, 1);
  });

  test("connecting before Vobiz completes the order is 'order_not_ready'; after, the connection and order are linked", async () => {
    const db = world();
    const pending = fakeVobiz({
      createChannel: new VobizApiError("Vobiz: Number order is not completed", "http", 422),
    });
    const order = await orderNumber(
      db.client,
      SCOPE,
      { phoneNumber: "+918000000001", requestedBy: "u1" },
      { vobiz: pending.vobiz },
    );
    await rejectsCode(
      connectPurchasedNumber(
        db.client,
        SCOPE,
        { orderId: order.id, wabaId: WABA },
        { vobiz: pending.vobiz },
      ),
      "order_not_ready",
    );
    assert.equal(db.rows("whatsapp_connections").length, 0);

    const done = fakeVobiz();
    (done.vobiz as { createChannel: (a: unknown) => Promise<VobizChannel> }).createChannel = async (
      a,
    ) => {
      done.calls.push({ method: "createChannel", args: a });
      return done.channel({
        id: "ch-bought",
        phoneNumber: "+918000000001",
        phoneNumberId: "555000111222",
        numberOrderId: "vobiz-order-1",
      });
    };
    const connected = await connectPurchasedNumber(
      db.client,
      SCOPE,
      { orderId: order.id, wabaId: WABA },
      { vobiz: done.vobiz },
    );
    assert.deepEqual(done.calls[0]!.args, {
      mode: "buy_from_vobiz",
      wabaId: WABA,
      numberOrderId: "vobiz-order-1",
      phoneNumber: "+918000000001",
      displayName: undefined,
    });
    const conn = db.rows("whatsapp_connections")[0]!;
    assert.equal(conn["number_onboarding_mode"], "buy_from_vobiz");
    assert.equal(conn["vobiz_number_order_id"], "vobiz-order-1");
    const ord = db.rows("whatsapp_number_orders")[0]!;
    assert.equal(ord["status"], "connected");
    assert.equal(ord["whatsapp_connection_id"], connected.connectionId);
    // Idempotent afterwards.
    const again = await connectPurchasedNumber(
      db.client,
      SCOPE,
      { orderId: order.id, wabaId: WABA },
      { vobiz: done.vobiz },
    );
    assert.equal(again.alreadyConnected, true);
  });

  test("another organization's order can't be connected", async () => {
    const db = world({
      whatsapp_number_orders: [
        {
          id: "ord-b",
          organization_id: OTHER_ORG,
          phone_number: "+918000000002",
          status: "completed",
          vobiz_order_id: "vo-b",
        },
      ],
    });
    const { vobiz, calls } = fakeVobiz();
    await rejectsCode(
      connectPurchasedNumber(db.client, SCOPE, { orderId: "ord-b", wabaId: WABA }, { vobiz }),
      "not_found",
    );
    assert.equal(calls.length, 0);
  });

  test("a channel without a phone number id is reported, never saved half-routed", async () => {
    const db = world({
      whatsapp_number_orders: [
        {
          id: "ord-1",
          organization_id: ORG,
          phone_number: "+918000000003",
          status: "completed",
          vobiz_order_id: "vo-1",
        },
      ],
    });
    const { vobiz, channel } = fakeVobiz();
    (vobiz as { createChannel: () => Promise<VobizChannel> }).createChannel = async () =>
      channel({ id: "ch-x", phoneNumberId: null });
    await assert.rejects(
      connectPurchasedNumber(db.client, SCOPE, { orderId: "ord-1", wabaId: WABA }, { vobiz }),
      (e: unknown) =>
        e instanceof WhatsAppOnboardingError &&
        e.code === "incomplete_channel" &&
        /ch-x/.test(e.message),
    );
    assert.equal(db.rows("whatsapp_connections").length, 0);
  });
});

describe("3. Embedded Signup through Vobiz", () => {
  test("hands Vobiz the Meta code and WABA id; the connection is saved", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    const r = await completeEmbeddedSignup(
      db.client,
      SCOPE,
      { code: "AQB-code", wabaId: WABA, phoneNumberId: PN_ID },
      { vobiz },
    );
    assert.deepEqual(calls[0], {
      method: "completeEmbeddedSignup",
      args: { code: "AQB-code", wabaId: WABA, phoneNumberId: PN_ID },
    });
    assert.equal(r.numberOnboardingMode, "embedded_signup");
    assert.equal(db.rows("whatsapp_connections")[0]!["number_onboarding_mode"], "embedded_signup");
  });

  test("an expired/used code is Vobiz's rejection and leaves nothing behind", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({
      completeEmbeddedSignup: new VobizApiError("Vobiz: Invalid authorization code", "http", 400),
    });
    await rejectsCode(
      completeEmbeddedSignup(
        db.client,
        SCOPE,
        { code: "used", wabaId: WABA, phoneNumberId: PN_ID },
        { vobiz },
      ),
      "provider_rejected",
    );
    assert.equal(db.rows("whatsapp_connections").length, 0);
  });

  test("a duplicate callback for an already connected number doesn't call Vobiz again", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    await completeEmbeddedSignup(
      db.client,
      SCOPE,
      { code: "c1", wabaId: WABA, phoneNumberId: PN_ID },
      { vobiz },
    );
    const again = await completeEmbeddedSignup(
      db.client,
      SCOPE,
      { code: "c1", wabaId: WABA, phoneNumberId: PN_ID },
      { vobiz },
    );
    assert.equal(again.alreadyConnected, true);
    assert.equal(calls.length, 1);
  });

  test("a number another organization has live is refused", async () => {
    const db = world({
      whatsapp_connections: [
        {
          id: "x",
          organization_id: OTHER_ORG,
          waba_id: "1",
          phone_number_id: PN_ID,
          status: "connected",
        },
      ],
    });
    const { vobiz, calls } = fakeVobiz();
    await rejectsCode(
      completeEmbeddedSignup(
        db.client,
        SCOPE,
        { code: "c", wabaId: WABA, phoneNumberId: PN_ID },
        { vobiz },
      ),
      "duplicate_phone_number",
    );
    assert.equal(calls.length, 0);
  });
});

describe("reconnect", () => {
  const disconnected = (over: Record<string, unknown> = {}) => ({
    id: "conn-1",
    organization_id: ORG,
    waba_id: WABA,
    phone_number_id: PN_ID,
    status: "disconnected",
    provider: "vobiz",
    vobiz_channel_id: "ch-1",
    ...over,
  });

  test("a disconnected Vobiz connection whose channel still exists comes back", async () => {
    const db = world({ whatsapp_connections: [disconnected()] });
    const { vobiz, channel } = fakeVobiz({}, []);
    (vobiz as { listChannels: () => Promise<VobizChannel[]> }).listChannels = async () => [
      channel(),
    ];
    await reconnectConnection(db.client, { ...SCOPE, connectionId: "conn-1" }, { vobiz });
    assert.equal(db.rows("whatsapp_connections")[0]!["status"], "connected");
  });

  test("refused when the channel is gone, the number is live elsewhere, or it's a legacy Meta row", async () => {
    const gone = world({ whatsapp_connections: [disconnected()] });
    await rejectsCode(
      reconnectConnection(
        gone.client,
        { ...SCOPE, connectionId: "conn-1" },
        { vobiz: fakeVobiz({}, []).vobiz },
      ),
      "not_found",
    );
    const taken = world({
      whatsapp_connections: [
        disconnected(),
        {
          id: "other",
          organization_id: OTHER_ORG,
          waba_id: "1",
          phone_number_id: PN_ID,
          status: "connected",
        },
      ],
    });
    await rejectsCode(
      reconnectConnection(
        taken.client,
        { ...SCOPE, connectionId: "conn-1" },
        { vobiz: fakeVobiz().vobiz },
      ),
      "duplicate_phone_number",
    );
    const legacy = world({
      whatsapp_connections: [disconnected({ provider: "meta_direct", vobiz_channel_id: null })],
    });
    await rejectsCode(
      reconnectConnection(
        legacy.client,
        { ...SCOPE, connectionId: "conn-1" },
        { vobiz: fakeVobiz().vobiz },
      ),
      "invalid_input",
    );
  });

  test("another organization's connection is not found", async () => {
    const db = world({ whatsapp_connections: [disconnected({ organization_id: OTHER_ORG })] });
    await rejectsCode(
      reconnectConnection(
        db.client,
        { ...SCOPE, connectionId: "conn-1" },
        { vobiz: fakeVobiz().vobiz },
      ),
      "not_found",
    );
  });
});
