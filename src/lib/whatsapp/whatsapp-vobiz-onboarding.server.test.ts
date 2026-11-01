import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BYON_OTP_REQUESTS_PER_HOUR,
  WhatsAppOnboardingError,
  completeEmbeddedSignup,
  connectByon,
  connectAssignedNumber,
  purchaseNumberForOrganization,
  reconnectConnection,
  requestClickAiNumber,
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
    startByonVerification: (a: unknown) =>
      run("startByonVerification", a, () => ({
        kind: "pending",
        verificationId: "ver-1",
        status: "pending",
        expiresAt: null,
      })),
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
    organizations: [{ id: ORG }, { id: OTHER_ORG }],
    phone_numbers: [],
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

describe("1b. BYON states: requested ≠ delivered ≠ verified ≠ connected", () => {
  const pending = (over: Record<string, unknown> = {}) => ({
    kind: "pending",
    verificationId: "ver-1",
    status: "pending",
    expiresAt: "2026-10-28T10:10:00.000Z",
    ...over,
  });
  const unrecognized = (over: Record<string, unknown> = {}) => ({
    kind: "unrecognized",
    reason: "unexpected_status",
    verificationId: "ver-2",
    status: "queued",
    keys: ["id", "status"],
    ...over,
  });
  async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
    const logged: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void logged.push(args);
    try {
      return { result: await fn(), logged };
    } finally {
      console.warn = original;
    }
  }

  test("a pending answer is 'verification_requested' with Vobiz's id and expiry — never delivered or connected", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({ startByonVerification: () => pending() });
    const r = await startByonVerification(
      db.client,
      SCOPE,
      { phoneNumber: PHONE, method: "sms" },
      { vobiz },
    );
    assert.deepEqual(r, {
      phoneNumber: PHONE,
      state: "verification_requested",
      deliveryConfirmed: false,
      providerReference: "ver-1",
      providerStatus: "pending",
      expiresAt: "2026-10-28T10:10:00.000Z",
    });
    const [v] = db.rows("whatsapp_byon_verifications");
    assert.equal(v!["organization_id"], ORG);
    assert.equal(v!["state"], "pending");
    assert.equal(v!["provider_verification_id"], "ver-1");
    assert.equal(v!["provider_status"], "pending");
    assert.equal(v!["expires_at"], "2026-10-28T10:10:00.000Z");
    const [event] = db.rows("customer_events");
    const meta = event!["metadata"] as Record<string, unknown>;
    assert.equal(meta["state"], "verification_requested");
    assert.equal(meta["provider_reference"], "ver-1");
    assert.equal(meta["provider_response_recognized"], true);
    assert.match(String(event!["title"]), /delivery not confirmed/);
    assert.equal(db.rows("whatsapp_connections").length, 0, "a 2xx never creates a connection");
  });

  for (const [label, answer] of [
    ["an unexpected status", unrecognized()],
    [
      "a missing verification id",
      unrecognized({ reason: "missing_id", verificationId: null, status: "pending" }),
    ],
    [
      "an empty or malformed body",
      unrecognized({
        reason: "empty_or_malformed_body",
        verificationId: null,
        status: null,
        keys: [],
      }),
    ],
  ] as const) {
    test(`a 2xx with ${label} is 'verification_unconfirmed' (outcome unknown), logged with validated fields only`, async () => {
      const db = world();
      const { vobiz } = fakeVobiz({ startByonVerification: () => answer });
      const { result: r, logged } = await captureWarn(() =>
        startByonVerification(db.client, SCOPE, { phoneNumber: PHONE, method: "sms" }, { vobiz }),
      );
      assert.equal(r.state, "verification_unconfirmed");
      assert.equal(r.deliveryConfirmed, false);
      assert.equal(r.expiresAt, null);
      assert.deepEqual(logged, [
        [
          "whatsapp_byon:verify_response_unrecognized",
          { reason: answer.reason, status: answer.status, keys: answer.keys },
        ],
      ]);
      assert.doesNotMatch(JSON.stringify(logged), /9876543210/, "the number is never logged");
      const [v] = db.rows("whatsapp_byon_verifications");
      assert.equal(v!["state"], "unrecognized");
      assert.equal(v!["expires_at"], null);
      const meta = db.rows("customer_events")[0]!["metadata"] as Record<string, unknown>;
      assert.equal(meta["provider_response_recognized"], false);
      assert.match(String(db.rows("customer_events")[0]!["title"]), /outcome unknown/);
    });
  }

  test("a 4xx is Vobiz's refusal: recorded 'rejected', no event, and it doesn't count toward the limit", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({
      startByonVerification: new VobizApiError("Vobiz: Number not eligible", "http", 422),
    });
    await rejectsCode(
      startByonVerification(db.client, SCOPE, { phoneNumber: PHONE, method: "sms" }, { vobiz }),
      "provider_rejected",
    );
    assert.equal(db.rows("whatsapp_byon_verifications")[0]!["state"], "rejected");
    assert.equal(db.rows("customer_events").length, 0);
    const ok = fakeVobiz();
    for (let i = 0; i < BYON_OTP_REQUESTS_PER_HOUR; i++) {
      await startByonVerification(
        db.client,
        SCOPE,
        { phoneNumber: PHONE, method: "sms" },
        { vobiz: ok.vobiz },
      );
    }
  });

  test("5xx, 429, timeout and network failure: outcome unknown — 'unavailable', counted, and the error never claims a send", async () => {
    for (const err of [
      new VobizApiError("x", "http", 500),
      new VobizApiError("x", "http", 502),
      new VobizApiError("x", "http", 429),
      new VobizApiError("Vobiz did not respond in time.", "timeout"),
      new VobizApiError("Could not reach Vobiz.", "network"),
    ]) {
      const db = world();
      const { vobiz } = fakeVobiz({ startByonVerification: err });
      const { logged } = await captureWarn(() =>
        rejectsCode(
          startByonVerification(db.client, SCOPE, { phoneNumber: PHONE, method: "sms" }, { vobiz }),
          "provider_unavailable",
        ),
      );
      assert.equal(db.rows("whatsapp_byon_verifications")[0]!["state"], "unavailable");
      assert.equal(db.rows("customer_events").length, 0);
      assert.deepEqual(logged, [
        ["whatsapp_byon:verify_outcome_unknown", { kind: err.kind, status: err.status }],
      ]);
    }
    const db = world();
    const { vobiz } = fakeVobiz({ startByonVerification: new VobizApiError("x", "timeout") });
    await assert.rejects(
      captureWarn(() =>
        startByonVerification(db.client, SCOPE, { phoneNumber: PHONE, method: "sms" }, { vobiz }),
      ),
      (e: unknown) => {
        assert.ok(e instanceof WhatsAppOnboardingError);
        assert.match(e.message, /can't tell whether a code was sent/);
        assert.doesNotMatch(e.message, /code (was )?sent to|delivered/i);
        return true;
      },
    );
  });

  test(`concurrent requests can't bypass the limit of ${BYON_OTP_REQUESTS_PER_HOUR}`, async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    const results = await Promise.allSettled(
      Array.from({ length: BYON_OTP_REQUESTS_PER_HOUR + 3 }, () =>
        startByonVerification(db.client, SCOPE, { phoneNumber: PHONE, method: "sms" }, { vobiz }),
      ),
    );
    assert.equal(
      results.filter((r) => r.status === "fulfilled").length,
      BYON_OTP_REQUESTS_PER_HOUR,
    );
    for (const r of results.filter((x) => x.status === "rejected")) {
      assert.equal(
        ((r as PromiseRejectedResult).reason as WhatsAppOnboardingError).code,
        "rate_limited",
      );
    }
    assert.equal(
      calls.length,
      BYON_OTP_REQUESTS_PER_HOUR,
      "Vobiz is called only for claimed requests",
    );
  });

  test("a code for a request Vobiz says has expired is refused before Vobiz is asked to confirm it", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz({
      startByonVerification: () => pending({ expiresAt: "2026-10-28T10:10:00.000Z" }),
    });
    await startByonVerification(db.client, SCOPE, { phoneNumber: PHONE, method: "sms" }, { vobiz });
    await rejectsCode(
      connectByon(db.client, SCOPE, byonInput, {
        vobiz,
        now: () => new Date("2026-10-28T10:10:01.000Z"),
      }),
      "verification_expired",
    );
    assert.ok(!calls.some((c) => c.method === "confirmByonVerification"));
    // Before expiry it goes ahead, and the request is marked confirmed.
    await connectByon(db.client, SCOPE, byonInput, {
      vobiz,
      now: () => new Date("2026-10-28T10:09:00.000Z"),
    });
    assert.equal(db.rows("whatsapp_byon_verifications")[0]!["state"], "confirmed");
  });

  test("no recorded request (e.g. made before tracking) leaves the code check to Vobiz", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    await connectByon(db.client, SCOPE, byonInput, { vobiz });
    assert.ok(calls.some((c) => c.method === "confirmByonVerification"));
  });

  test("the code a customer types is never stored or logged; an invalid or expired code is Vobiz's rejection", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({
      confirmByonVerification: new VobizApiError("Vobiz: OTP expired", "http", 400),
    });
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await rejectsCode(
        connectByon(db.client, SCOPE, { ...byonInput, otpCode: "424242" }, { vobiz }),
        "provider_rejected",
      );
    } finally {
      console.error = original;
    }
    assert.equal(db.rows("whatsapp_connections").length, 0);
    const everything = JSON.stringify([
      db.rows("customer_events"),
      db.rows("whatsapp_connections"),
      logged,
    ]);
    assert.doesNotMatch(everything, /424242/);
    assert.doesNotMatch(everything, new RegExp(META_TOKEN));
  });

  test("a number another organization already has live is refused before any code is sent", async () => {
    const db = world({
      whatsapp_connections: [
        {
          organization_id: OTHER_ORG,
          phone_number_id: PN_ID,
          display_phone_number: PHONE,
          status: "connected",
          provider: "vobiz",
          vobiz_channel_id: "ch-x",
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

  test("a database without the Vobiz columns fails connect BEFORE the code is confirmed (the code isn't used up)", async () => {
    const db = createFakeDb(
      { whatsapp_connections: [], customer_events: [], phone_numbers: [] },
      {
        failWhen: (table, op) =>
          table === "whatsapp_connections" && op === "select"
            ? {
                code: "42703",
                message: "column whatsapp_connections.number_onboarding_mode does not exist",
              }
            : null,
      },
    );
    const { vobiz, calls } = fakeVobiz();
    await assert.rejects(
      connectByon(db.client, SCOPE, byonInput, { vobiz }),
      (e: unknown) => (e as { code?: string }).code === "42703",
    );
    assert.equal(calls.length, 0, "Vobiz confirm/create never reached");
  });
});

describe("1c. channel recovery never crosses organizations", () => {
  const conflict409 = () => new VobizApiError("Vobiz: channel exists", "http", 409);
  const listed = (over: Partial<VobizChannel>): VobizChannel => ({
    id: "ch-1",
    wabaId: WABA,
    phoneNumberId: PN_ID,
    phoneNumber: PHONE,
    displayName: null,
    numberOnboardingMode: "bring_your_own",
    numberOrderId: null,
    ...over,
  });

  test("org A disconnected; org B reconnecting the same number never inherits A's channel", async () => {
    const db = world({
      whatsapp_connections: [
        {
          id: "conn-a",
          organization_id: OTHER_ORG,
          phone_number_id: PN_ID,
          display_phone_number: PHONE,
          waba_id: WABA,
          status: "disconnected",
          provider: "vobiz",
          vobiz_channel_id: "ch-a",
        },
      ],
    });
    // Vobiz still has A's channel, with every identifier B typed in.
    const { vobiz } = fakeVobiz({ createChannel: conflict409() }, [listed({ id: "ch-a" })]);
    await rejectsCode(connectByon(db.client, SCOPE, byonInput, { vobiz }), "recovery_refused");
    assert.equal(
      db.rows("whatsapp_connections").filter((c) => c["organization_id"] === ORG).length,
      0,
    );
    // A's row is untouched.
    assert.equal(db.rows("whatsapp_connections")[0]!["status"], "disconnected");
  });

  for (const [label, channel] of [
    ["has no WABA id", listed({ wabaId: null })],
    ["is on another WABA", listed({ wabaId: "999888777666555" })],
    ["has another phone number id", listed({ phoneNumberId: "555444333222111" })],
    ["has no phone number id", listed({ phoneNumberId: null })],
  ] as const) {
    test(`a recovered channel that ${label} is refused, never adopted`, async () => {
      const db = world();
      const logged: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void logged.push(args);
      try {
        const { vobiz } = fakeVobiz({ createChannel: conflict409() }, [channel]);
        await rejectsCode(connectByon(db.client, SCOPE, byonInput, { vobiz }), "recovery_refused");
      } finally {
        console.error = original;
      }
      assert.equal(db.rows("whatsapp_connections").length, 0);
      assert.doesNotMatch(JSON.stringify(logged), new RegExp(META_TOKEN));
      assert.doesNotMatch(JSON.stringify(logged), /9876543210/);
    });
  }

  test("two channels matching is ambiguous and refused", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({ createChannel: conflict409() }, [
      listed({ id: "ch-1" }),
      listed({ id: "ch-2" }),
    ]);
    const original = console.error;
    console.error = () => {};
    try {
      await rejectsCode(connectByon(db.client, SCOPE, byonInput, { vobiz }), "recovery_refused");
    } finally {
      console.error = original;
    }
  });

  test("a created channel on another WABA than requested is refused (Vobiz's answer must match)", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({
      createChannel: () => listed({ wabaId: "999888777666555" }),
    });
    const original = console.error;
    console.error = () => {};
    try {
      await rejectsCode(connectByon(db.client, SCOPE, byonInput, { vobiz }), "recovery_refused");
    } finally {
      console.error = original;
    }
    assert.equal(db.rows("whatsapp_connections").length, 0);
  });

  test("timeout after Vobiz created the channel, then a failed save: the retry adopts that same channel once", async () => {
    let failInsert = true;
    const db = createFakeDb(
      { organizations: [{ id: ORG }, { id: OTHER_ORG }], phone_numbers: [], customer_events: [] },
      {
        failWhen: (table, op) => {
          if (table === "whatsapp_connections" && op === "insert" && failInsert) {
            failInsert = false;
            return { code: "08006", message: "connection failure" };
          }
          return null;
        },
      },
    );
    const { vobiz, calls } = fakeVobiz(
      { createChannel: new VobizApiError("Vobiz did not respond in time.", "timeout") },
      [listed({ id: "ch-made" })],
    );
    await assert.rejects(connectByon(db.client, SCOPE, byonInput, { vobiz }));
    assert.equal(db.rows("whatsapp_connections").length, 0);
    const r = await connectByon(db.client, SCOPE, byonInput, { vobiz });
    const rows = db.rows("whatsapp_connections");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["vobiz_channel_id"], "ch-made");
    assert.equal(rows[0]!["organization_id"], ORG);
    assert.equal(r.connectionId, rows[0]!["id"]);
    assert.equal(calls.filter((c) => c.method === "listChannels").length, 2);
  });

  test("two organizations onboarding the same number concurrently: one connection, the other is refused", async () => {
    const db = world();
    const a = fakeVobiz();
    const b = fakeVobiz();
    const results = await Promise.allSettled([
      connectByon(db.client, SCOPE, byonInput, { vobiz: a.vobiz }),
      connectByon(
        db.client,
        { ...SCOPE, organizationId: OTHER_ORG, businessId: "biz-b" },
        byonInput,
        {
          vobiz: b.vobiz,
        },
      ),
    ]);
    const live = db.rows("whatsapp_connections").filter((c) => c["status"] !== "disconnected");
    assert.equal(live.length, 1);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(refused.reason instanceof WhatsAppOnboardingError);
    assert.ok(
      ["duplicate_phone_number", "recovery_refused"].includes(refused.reason.code),
      refused.reason.code,
    );
  });

  test("the rightful organization's concurrent repeats end in one connection, both succeeding", async () => {
    const db = world();
    const { vobiz } = fakeVobiz();
    const [r1, r2] = await Promise.all([
      connectByon(db.client, SCOPE, byonInput, { vobiz }),
      connectByon(db.client, SCOPE, byonInput, { vobiz }),
    ]);
    assert.equal(db.rows("whatsapp_connections").length, 1);
    assert.equal(r1.connectionId, r2.connectionId);
  });
});

describe("2. ClickAI numbers: platform-admin purchase", () => {
  const NUMBER = "+918000000001";
  const buy = (
    db: ReturnType<typeof world>,
    vobiz: unknown,
    over: Partial<Parameters<typeof purchaseNumberForOrganization>[1]> = {},
  ) =>
    purchaseNumberForOrganization(
      db.client,
      { organizationId: ORG, phoneNumber: NUMBER, country: "IN", requestedBy: "admin-1", ...over },
      { vobiz: vobiz as never },
    );

  test("records the order and the organization's WhatsApp-only inventory number together", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    const order = await buy(db, vobiz);
    assert.equal(order.status, "pending");
    assert.equal(order.alreadyOrdered, false);
    assert.equal(calls.filter((c) => c.method === "createNumberOrder").length, 1);
    const row = db.rows("whatsapp_number_orders")[0]!;
    assert.equal(
      row["organization_id"],
      null,
      "admin orders are platform records, not tenant data",
    );
    assert.equal(row["requested_by"], "admin-1");
    assert.equal(row["vobiz_order_id"], "vobiz-order-1");
    const number = db.rows("phone_numbers")[0]!;
    assert.equal(order.inventoryNumberId, number["id"]);
    assert.equal(row["phone_number_inventory_id"], number["id"]);
    assert.deepEqual(
      [
        number["organization_id"],
        number["status"],
        number["voice_capable"],
        number["whatsapp_capable"],
        number["inbound_enabled"],
      ],
      [ORG, "provisioning", false, true, false],
    );
  });

  test("a double click / retry / second admin never buys twice", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    const first = await buy(db, vobiz);
    const second = await buy(db, vobiz, { requestedBy: "admin-2", organizationId: OTHER_ORG });
    assert.equal(second.alreadyOrdered, true);
    assert.equal(second.id, first.id);
    assert.equal(calls.filter((c) => c.method === "createNumberOrder").length, 1);
    assert.equal(db.rows("phone_numbers").length, 1);
  });

  test("concurrent purchases of the same number reach Vobiz once", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz();
    const [a, b] = await Promise.all([
      buy(db, vobiz),
      buy(db, vobiz, { requestedBy: "admin-2", organizationId: OTHER_ORG }),
    ]);
    assert.equal(calls.filter((c) => c.method === "createNumberOrder").length, 1);
    assert.equal(a.id, b.id);
    assert.deepEqual([a.alreadyOrdered, b.alreadyOrdered].sort(), [false, true]);
    assert.equal(db.rows("phone_numbers").length, 1);
  });

  test("a Vobiz rejection marks the order failed (a new attempt is allowed)", async () => {
    const db = world();
    const { vobiz } = fakeVobiz({
      createNumberOrder: new VobizApiError("Vobiz: Number unavailable", "http", 422),
    });
    await rejectsCode(buy(db, vobiz), "provider_rejected");
    assert.equal(db.rows("whatsapp_number_orders")[0]!["status"], "failed");
    assert.equal(db.rows("phone_numbers").length, 0);
    const retry = await buy(db, fakeVobiz().vobiz);
    assert.equal(retry.status, "pending");
  });

  test("no response: 'unknown', no inventory row, and a repeat does NOT buy again", async () => {
    const db = world();
    const { vobiz, calls } = fakeVobiz({ createNumberOrder: new VobizApiError("x", "timeout") });
    await rejectsCode(buy(db, vobiz), "provider_unavailable");
    assert.equal(db.rows("whatsapp_number_orders")[0]!["status"], "unknown");
    assert.equal(db.rows("phone_numbers").length, 0);
    const again = await buy(db, vobiz);
    assert.equal(again.alreadyOrdered, true);
    assert.equal(calls.filter((c) => c.method === "createNumberOrder").length, 1);
  });

  test("a Vobiz success that can't be recorded keeps the lock, logs both ids, and is never bought again", async () => {
    let failRecord = true;
    const db = createFakeDb(
      {
        organizations: [{ id: ORG }],
        phone_numbers: [],
        whatsapp_connections: [],
        whatsapp_number_orders: [],
        customer_events: [],
      },
      {
        failWhen: (table) =>
          failRecord && table === "rpc:record_whatsapp_number_purchase"
            ? { code: "08006", message: "connection failure" }
            : null,
      },
    );
    const { vobiz, calls } = fakeVobiz();
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(JSON.stringify(args));
    let reference = "";
    try {
      await assert.rejects(buy(db as never, vobiz), (e: unknown) => {
        assert.ok(e instanceof WhatsAppOnboardingError);
        assert.match(
          e.message,
          /Vobiz accepted the order \(vobiz-order-1\), but ClickAI couldn't record it/,
        );
        reference = String(db.rows("whatsapp_number_orders")[0]!["id"]);
        assert.ok(e.message.includes(reference));
        return true;
      });
    } finally {
      console.error = original;
    }
    assert.ok(logged.some((l) => l.includes("vobiz-order-1") && l.includes(reference)));
    assert.equal(
      db.rows("whatsapp_number_orders")[0]!["status"],
      "requested",
      "the lock stays live",
    );
    assert.equal(db.rows("phone_numbers").length, 0, "no half-recorded number");
    failRecord = false;
    const again = await buy(db as never, vobiz);
    assert.equal(again.alreadyOrdered, true);
    assert.equal(calls.filter((c) => c.method === "createNumberOrder").length, 1);
  });

  test("refused before Vobiz when ClickAI already holds the number or a customer has it on WhatsApp", async () => {
    for (const seed of [
      {
        phone_numbers: [
          {
            organization_id: OTHER_ORG,
            e164: NUMBER,
            status: "active",
            voice_capable: true,
            whatsapp_capable: false,
          },
        ],
      },
      {
        whatsapp_connections: [
          {
            organization_id: OTHER_ORG,
            display_phone_number: NUMBER,
            status: "connected",
            phone_number_id: "pn-x",
          },
        ],
      },
    ]) {
      const db = world(seed);
      const { vobiz, calls } = fakeVobiz();
      await rejectsCode(buy(db, vobiz), "duplicate_phone_number");
      assert.equal(calls.length, 0);
      assert.equal(db.rows("whatsapp_number_orders")[0]!["status"], "failed", "lock released");
    }
  });

  test("an unknown client is refused before anything is written", async () => {
    const db = createFakeDb({ organizations: [{ id: ORG }], whatsapp_number_orders: [] });
    const { vobiz, calls } = fakeVobiz();
    await rejectsCode(
      purchaseNumberForOrganization(
        db.client,
        { organizationId: "nope", phoneNumber: NUMBER, country: "IN", requestedBy: "a" },
        { vobiz },
      ),
      "not_found",
    );
    assert.equal(calls.length, 0);
    assert.equal(db.rows("whatsapp_number_orders").length, 0);
  });
});

describe("2b. ClickAI numbers: the customer connects an assigned number", () => {
  const NUMBER = "+918000000001";
  const assigned = (over: Record<string, unknown> = {}) => ({
    phone_numbers: [
      {
        id: "num-1",
        organization_id: ORG,
        e164: NUMBER,
        status: "active",
        voice_capable: false,
        whatsapp_capable: true,
        ...over,
      },
    ],
    whatsapp_number_orders: [
      {
        id: "ord-1",
        organization_id: null,
        phone_number: NUMBER,
        status: "completed",
        vobiz_order_id: "vobiz-order-1",
        phone_number_inventory_id: "num-1",
      },
    ],
  });
  const boughtChannel = (v: ReturnType<typeof fakeVobiz>, over: Partial<VobizChannel> = {}) =>
    v.channel({
      id: "ch-bought",
      phoneNumber: NUMBER,
      phoneNumberId: "555000111222",
      numberOrderId: "vobiz-order-1",
      numberOnboardingMode: "buy_from_vobiz",
      ...over,
    });

  test("an active assigned number is connected to the customer's WABA and linked to the inventory row", async () => {
    const db = world(assigned());
    const v = fakeVobiz();
    (v.vobiz as { createChannel: (a: unknown) => Promise<VobizChannel> }).createChannel = async (
      a,
    ) => {
      v.calls.push({ method: "createChannel", args: a });
      return boughtChannel(v);
    };
    const r = await connectAssignedNumber(
      db.client,
      SCOPE,
      { numberId: "num-1", wabaId: WABA },
      { vobiz: v.vobiz },
    );
    assert.deepEqual(v.calls[0]!.args, {
      mode: "buy_from_vobiz",
      wabaId: WABA,
      numberOrderId: "vobiz-order-1",
      phoneNumber: NUMBER,
      displayName: undefined,
    });
    const conn = db.rows("whatsapp_connections")[0]!;
    assert.equal(conn["organization_id"], ORG);
    assert.equal(conn["inventory_number_id"], "num-1");
    assert.equal(conn["number_onboarding_mode"], "buy_from_vobiz");
    const again = await connectAssignedNumber(
      db.client,
      SCOPE,
      { numberId: "num-1", wabaId: WABA },
      { vobiz: v.vobiz },
    );
    assert.equal(again.alreadyConnected, true);
    assert.equal(again.connectionId, r.connectionId);
    assert.equal(v.calls.filter((c) => c.method === "createChannel").length, 1);
  });

  test("another organization's number is not found (and Vobiz is never called)", async () => {
    const db = world(assigned({ organization_id: OTHER_ORG }));
    const { vobiz, calls } = fakeVobiz();
    await rejectsCode(
      connectAssignedNumber(db.client, SCOPE, { numberId: "num-1", wabaId: WABA }, { vobiz }),
      "not_found",
    );
    assert.equal(calls.length, 0);
  });

  test("voice-only, released or not-yet-activated numbers can't be connected", async () => {
    for (const [over, code] of [
      [{ whatsapp_capable: false, voice_capable: true }, "not_found"],
      [{ status: "released" }, "not_found"],
      [{ status: "provisioning" }, "order_not_ready"],
    ] as const) {
      const db = world(assigned(over));
      const { vobiz, calls } = fakeVobiz();
      await rejectsCode(
        connectAssignedNumber(db.client, SCOPE, { numberId: "num-1", wabaId: WABA }, { vobiz }),
        code,
      );
      assert.equal(calls.length, 0);
    }
  });

  test("Vobiz refusing an incomplete order is 'order_not_ready' and saves nothing", async () => {
    const db = world(assigned());
    const { vobiz } = fakeVobiz({
      createChannel: new VobizApiError("Vobiz: Number order is not completed", "http", 422),
    });
    await rejectsCode(
      connectAssignedNumber(db.client, SCOPE, { numberId: "num-1", wabaId: WABA }, { vobiz }),
      "order_not_ready",
    );
    assert.equal(db.rows("whatsapp_connections").length, 0);
  });

  test("after reassignment, the previous customer's channel is never adopted", async () => {
    // Org B used this number, disconnected, and an admin reassigned it to org A.
    const seed = assigned();
    const db = world({
      ...seed,
      whatsapp_connections: [
        {
          id: "old-conn",
          organization_id: OTHER_ORG,
          phone_number_id: "555000111222",
          display_phone_number: NUMBER,
          status: "disconnected",
          provider: "vobiz",
          vobiz_channel_id: "ch-old",
          inventory_number_id: "num-1",
        },
      ],
    });
    // Vobiz still has org B's channel (other WABA); creating a new one conflicts.
    const v = fakeVobiz(
      { createChannel: new VobizApiError("Vobiz: channel exists", "http", 409) },
      [],
    );
    (v.vobiz as { listChannels: () => Promise<VobizChannel[]> }).listChannels = async () => [
      boughtChannel(v, { id: "ch-old", wabaId: "999888777666555" }),
    ];
    await rejectsCode(
      connectAssignedNumber(
        db.client,
        SCOPE,
        { numberId: "num-1", wabaId: WABA },
        { vobiz: v.vobiz },
      ),
      // A channel for this number on another WABA: recovery refuses (for an
      // administrator to resolve) instead of adopting org B's channel.
      "recovery_refused",
    );
    // Same WABA id, but the channel is org B's: still refused.
    (v.vobiz as { listChannels: () => Promise<VobizChannel[]> }).listChannels = async () => [
      boughtChannel(v, { id: "ch-old" }),
    ];
    await rejectsCode(
      connectAssignedNumber(
        db.client,
        SCOPE,
        { numberId: "num-1", wabaId: WABA },
        { vobiz: v.vobiz },
      ),
      "recovery_refused", // matches every id, but org B used it before
    );
    assert.equal(
      db.rows("whatsapp_connections").filter((c) => c["organization_id"] === ORG).length,
      0,
    );
  });

  test("a channel without a phone number id is reported, never saved half-routed", async () => {
    const db = world(assigned());
    const { vobiz, channel } = fakeVobiz();
    (vobiz as { createChannel: () => Promise<VobizChannel> }).createChannel = async () =>
      channel({ id: "ch-x", phoneNumberId: null });
    await assert.rejects(
      connectAssignedNumber(db.client, SCOPE, { numberId: "num-1", wabaId: WABA }, { vobiz }),
      (e: unknown) =>
        e instanceof WhatsAppOnboardingError &&
        e.code === "incomplete_channel" &&
        /ch-x/.test(e.message),
    );
    assert.equal(db.rows("whatsapp_connections").length, 0);
  });

  test("asking ClickAI for a number queues one request event and buys nothing", async () => {
    const db = world();
    const first = await requestClickAiNumber(db.client, SCOPE, { actorEmail: "o@x.in" });
    const second = await requestClickAiNumber(db.client, SCOPE, { actorEmail: "o@x.in" });
    assert.deepEqual(first, { alreadyHasNumber: false, alreadyRequested: false });
    assert.deepEqual(second, { alreadyHasNumber: false, alreadyRequested: true });
    assert.equal(
      db.rows("customer_events").filter((e) => e["kind"] === "whatsapp_number_requested").length,
      1,
    );
    assert.equal(db.rows("whatsapp_number_orders").length, 0);
    const withNumber = world(assigned());
    assert.deepEqual(await requestClickAiNumber(withNumber.client, SCOPE, { actorEmail: null }), {
      alreadyHasNumber: true,
      alreadyRequested: false,
    });
  });
});

describe("2c. customer-owned numbers vs ClickAI's inventory", () => {
  test("BYON of a number ClickAI holds for another organization (or unassigned) is refused before any OTP", async () => {
    for (const organization_id of [OTHER_ORG, null]) {
      const db = world({
        phone_numbers: [
          {
            organization_id,
            e164: PHONE,
            status: "active",
            voice_capable: true,
            whatsapp_capable: false,
          },
        ],
      });
      const { vobiz, calls } = fakeVobiz();
      await rejectsCode(
        startByonVerification(db.client, SCOPE, { phoneNumber: PHONE, method: "sms" }, { vobiz }),
        "duplicate_phone_number",
      );
      await rejectsCode(
        connectByon(db.client, SCOPE, byonInput, { vobiz }),
        "duplicate_phone_number",
      );
      assert.equal(calls.length, 0);
    }
  });

  test("BYON of this organization's own ClickAI voice number still works", async () => {
    const db = world({
      phone_numbers: [
        {
          organization_id: ORG,
          e164: PHONE,
          status: "active",
          voice_capable: true,
          whatsapp_capable: false,
        },
      ],
    });
    const { vobiz } = fakeVobiz();
    const r = await connectByon(db.client, SCOPE, byonInput, { vobiz });
    assert.equal(r.alreadyConnected, false);
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
