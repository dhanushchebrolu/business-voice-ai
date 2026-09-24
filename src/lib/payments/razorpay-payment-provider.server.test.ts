import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { RazorpayPaymentProvider } from "./razorpay-payment-provider.server.ts";
import { PaymentProviderError } from "./payment-provider.ts";
import { encryptCredential } from "../razorpay/razorpay-crypto.server.ts";

const CRYPTO_KEY = "RAZORPAY_CREDENTIAL_ENCRYPTION_KEY";
const CONFIG_VARS = [
  "RAZORPAY_CLIENT_ID",
  "RAZORPAY_CLIENT_SECRET",
  "RAZORPAY_REDIRECT_URI",
  "RAZORPAY_OAUTH_AUTHORIZE_URL",
  "RAZORPAY_OAUTH_TOKEN_URL",
  "RAZORPAY_OAUTH_SCOPE",
] as const;
const originalValues: Record<string, string | undefined> = {};

beforeEach(() => {
  originalValues[CRYPTO_KEY] = process.env[CRYPTO_KEY];
  process.env[CRYPTO_KEY] = randomBytes(32).toString("base64");
  for (const key of CONFIG_VARS) {
    originalValues[key] = process.env[key];
    process.env[key] = `test-${key.toLowerCase()}`;
  }
  originalValues["RAZORPAY_MERCHANT_DETAILS_URL"] = process.env["RAZORPAY_MERCHANT_DETAILS_URL"];
  delete process.env["RAZORPAY_MERCHANT_DETAILS_URL"];
});

afterEach(() => {
  for (const key of [CRYPTO_KEY, ...CONFIG_VARS, "RAZORPAY_MERCHANT_DETAILS_URL"]) {
    if (originalValues[key] === undefined) delete process.env[key];
    else process.env[key] = originalValues[key];
  }
});

function makeFakeSupabase(script: { table: string; op: string; result: unknown }[]) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  let i = 0;
  function next(table: string, op: string, ...args: unknown[]) {
    calls.push({ table, op, args });
    const entry = script[i];
    i++;
    if (!entry) throw new Error(`test bug: no scripted response for call ${i} (${table}.${op})`);
    return entry.result;
  }
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle", filters)),
        upsert(payload: unknown, opts: unknown) {
          return {
            select: () => ({
              single: () => Promise.resolve(next(table, "upsert.single", payload, opts)),
            }),
          };
        },
        update(payload: unknown) {
          return {
            eq: (col: string, val: unknown) =>
              Promise.resolve(next(table, "update", payload, { [col]: val })),
          };
        },
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

function fakeFetchSequence(responses: { status: number; body: unknown }[]): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("RazorpayPaymentProvider.getConnectionStatus", () => {
  test("returns the constructed initial status without any I/O", () => {
    const { client } = makeFakeSupabase([]);
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin: client,
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
      },
      "CONNECTED",
    );
    assert.equal(provider.getConnectionStatus(), "CONNECTED");
  });

  test("defaults to DISCONNECTED when no initial status is given", () => {
    const { client } = makeFakeSupabase([]);
    const provider = new RazorpayPaymentProvider({
      supabaseAdmin: client,
      organizationId: "org-1",
      businessId: "biz-1",
      connectionId: undefined,
    });
    assert.equal(provider.getConnectionStatus(), "DISCONNECTED");
  });
});

describe("RazorpayPaymentProvider connection-less operations", () => {
  test("verifyConnection throws MERCHANT_NOT_FOUND when no connection exists yet", async () => {
    const { client } = makeFakeSupabase([]);
    const provider = new RazorpayPaymentProvider({
      supabaseAdmin: client,
      organizationId: "org-1",
      businessId: "biz-1",
      connectionId: undefined,
    });
    await assert.rejects(
      () => provider.verifyConnection(),
      (err: unknown) => {
        assert.ok(err instanceof PaymentProviderError);
        assert.equal(err.code, "MERCHANT_NOT_FOUND");
        return true;
      },
    );
  });

  test("disconnect throws MERCHANT_NOT_FOUND when no connection exists yet", async () => {
    const { client } = makeFakeSupabase([]);
    const provider = new RazorpayPaymentProvider({
      supabaseAdmin: client,
      organizationId: "org-1",
      businessId: "biz-1",
      connectionId: undefined,
    });
    await assert.rejects(
      () => provider.disconnect(),
      (err: unknown) => {
        assert.ok(err instanceof PaymentProviderError);
        assert.equal(err.code, "MERCHANT_NOT_FOUND");
        return true;
      },
    );
  });
});

describe("RazorpayPaymentProvider.connect", () => {
  test("completes OAuth, updates status to CONNECTED, and returns merchant details", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "upsert.single",
        result: { data: { id: "conn-1" }, error: null },
      },
      // getMerchantDetails() -> getValidAccessTokenInternal() re-reads the
      // row it just wrote to obtain a usable access token.
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            connection_status: "CONNECTED",
            encrypted_credentials: encryptCredential(
              JSON.stringify({ accessToken: "access-1", refreshToken: "refresh-1" }),
            ),
            token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          error: null,
        },
      },
      // getMerchantDetails() fallback path (no merchant-details endpoint
      // configured) then reads the row's stored merchant fields.
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            razorpay_account_id: "acc_ABC123",
            business_name: "Example Business",
            display_name: null,
            email: "biz@example.com",
            phone: null,
            merchant_status: null,
          },
          error: null,
        },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      {
        status: 200,
        body: {
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          razorpay_account_id: "acc_ABC123",
        },
      },
    ]);
    const provider = new RazorpayPaymentProvider({
      supabaseAdmin: client,
      organizationId: "org-1",
      businessId: "biz-1",
      connectionId: undefined,
      fetchImpl,
    });

    const details = await provider.connect("auth-code");
    assert.equal(details.accountId, "acc_ABC123");
    assert.equal(details.businessName, "Example Business");
    assert.equal(provider.getConnectionStatus(), "CONNECTED");
  });

  test("never returns a fake CONNECTED status when the code exchange fails", async () => {
    const { client } = makeFakeSupabase([]);
    const fetchImpl = fakeFetchSequence([{ status: 400, body: { error: "invalid_grant" } }]);
    const provider = new RazorpayPaymentProvider({
      supabaseAdmin: client,
      organizationId: "org-1",
      businessId: "biz-1",
      connectionId: undefined,
      fetchImpl,
    });
    await assert.rejects(() => provider.connect("bad-code"), PaymentProviderError);
    assert.equal(provider.getConnectionStatus(), "ERROR");
  });
});

describe("RazorpayPaymentProvider.disconnect", () => {
  test("clears credentials and sets status to DISCONNECTED", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-1" }, error: null },
      },
      { table: "razorpay_connections", op: "update", result: { error: null } },
    ]);
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin: client,
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
      },
      "CONNECTED",
    );
    await provider.disconnect();
    assert.equal(provider.getConnectionStatus(), "DISCONNECTED");
    const payload = calls[1]!.args[0] as Record<string, unknown>;
    assert.equal(payload["connection_status"], "DISCONNECTED");
  });
});

describe("RazorpayPaymentProvider.verifyConnection / getValidAccessToken", () => {
  test("verifyConnection reflects REAUTH_REQUIRED and updates the provider's own status", async () => {
    const encrypted = encryptCredential(
      JSON.stringify({ accessToken: "old-access", refreshToken: "revoked-token" }),
    );
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: { id: "conn-1", organization_id: "org-1", connection_status: "CONNECTED" },
          error: null,
        },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            connection_status: "CONNECTED",
            encrypted_credentials: encrypted,
            token_expires_at: new Date(Date.now() - 1000).toISOString(),
          },
          error: null,
        },
      },
      { table: "razorpay_connections", op: "update", result: { error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([{ status: 400, body: { error: "invalid_grant" } }]);
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin: client,
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
        fetchImpl,
      },
      "CONNECTED",
    );
    const status = await provider.verifyConnection();
    assert.equal(status, "REAUTH_REQUIRED");
    assert.equal(provider.getConnectionStatus(), "REAUTH_REQUIRED");
  });

  test("getValidAccessToken never returns a token to a caller once REAUTH_REQUIRED — throws instead", async () => {
    const encrypted = encryptCredential(JSON.stringify({ accessToken: "old-access" }));
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            connection_status: "CONNECTED",
            encrypted_credentials: encrypted,
            token_expires_at: new Date(Date.now() - 1000).toISOString(),
          },
          error: null,
        },
      },
      { table: "razorpay_connections", op: "update", result: { error: null } },
    ]);
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin: client,
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
      },
      "CONNECTED",
    );
    await assert.rejects(
      () => provider.getValidAccessToken(),
      (err: unknown) => {
        assert.ok(err instanceof PaymentProviderError);
        assert.equal(err.code, "AUTH_REQUIRED");
        return true;
      },
    );
    assert.equal(provider.getConnectionStatus(), "REAUTH_REQUIRED");
  });
});

// A function, not a top-level constant: encryptCredential() requires
// RAZORPAY_CREDENTIAL_ENCRYPTION_KEY, which beforeEach only sets once a
// test is actually running — a top-level call would execute at module
// load time, before any beforeEach hook.
function makeStillValidCredentialsRow() {
  return {
    id: "conn-1",
    connection_status: "CONNECTED",
    encrypted_credentials: encryptCredential(
      JSON.stringify({ accessToken: "cached-access", refreshToken: "stored-refresh" }),
    ),
    token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe("RazorpayPaymentProvider.createPaymentRequest", () => {
  test("creates a real payment link and never returns a CAPTURED status", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: makeStillValidCredentialsRow(), error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { razorpay_account_id: "acc_connected_123" }, error: null },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
    ]);
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin: client,
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
        fetchImpl,
      },
      "CONNECTED",
    );
    const result = await provider.createPaymentRequest({
      amountMinorUnits: 50000,
      currency: "INR",
      description: "Appointment deposit",
      customerName: "Priya Sharma",
      customerPhone: "+919876543210",
      customerEmail: undefined,
      idempotencyKey: "booking-abc-123",
      notes: { booking_id: "booking-abc-123" },
    });
    assert.equal(result.providerPaymentLinkId, "plink_abc");
    assert.equal(result.paymentLinkUrl, "https://rzp.io/i/abc");
    assert.notEqual(result.status, "CAPTURED");
    assert.equal(result.status, "PENDING");
  });

  test("throws MERCHANT_NOT_FOUND when no connection exists yet (never fabricates a link)", async () => {
    const { client } = makeFakeSupabase([]);
    const provider = new RazorpayPaymentProvider({
      supabaseAdmin: client,
      organizationId: "org-1",
      businessId: "biz-1",
      connectionId: undefined,
    });
    await assert.rejects(
      () =>
        provider.createPaymentRequest({
          amountMinorUnits: 50000,
          currency: "INR",
          description: "x",
          customerName: undefined,
          customerPhone: undefined,
          customerEmail: undefined,
          idempotencyKey: "k",
          notes: {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof PaymentProviderError);
        assert.equal(err.code, "MERCHANT_NOT_FOUND");
        return true;
      },
    );
  });

  test("maps a provider 401 to AUTH_REQUIRED and updates connection status to REAUTH_REQUIRED", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: makeStillValidCredentialsRow(), error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { razorpay_account_id: "acc_connected_123" }, error: null },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      { status: 401, body: { error: { description: "invalid token" } } },
    ]);
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin: client,
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
        fetchImpl,
      },
      "CONNECTED",
    );
    await assert.rejects(
      () =>
        provider.createPaymentRequest({
          amountMinorUnits: 50000,
          currency: "INR",
          description: "x",
          customerName: undefined,
          customerPhone: undefined,
          customerEmail: undefined,
          idempotencyKey: "k",
          notes: {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof PaymentProviderError);
        assert.equal(err.code, "AUTH_REQUIRED");
        return true;
      },
    );
    assert.equal(provider.getConnectionStatus(), "REAUTH_REQUIRED");
  });

  test("never leaks the access token into a thrown error message", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: makeStillValidCredentialsRow(), error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { razorpay_account_id: "acc_connected_123" }, error: null },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      { status: 400, body: { error: { description: "bad request" } } },
    ]);
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin: client,
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
        fetchImpl,
      },
      "CONNECTED",
    );
    try {
      await provider.createPaymentRequest({
        amountMinorUnits: 50000,
        currency: "INR",
        description: "x",
        customerName: undefined,
        customerPhone: undefined,
        customerEmail: undefined,
        idempotencyKey: "k",
        notes: {},
      });
      assert.fail("expected createPaymentRequest to throw");
    } catch (err) {
      assert.doesNotMatch((err as Error).message, /cached-access/);
    }
  });
});

describe("RazorpayPaymentProvider.getPaymentRequestStatus", () => {
  test("reflects Razorpay's own reported status (read-only, never mutates)", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: makeStillValidCredentialsRow(), error: null },
      },
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { razorpay_account_id: "acc_connected_123" }, error: null },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      { status: 200, body: { id: "plink_abc", status: "paid", amount_paid: 50000 } },
    ]);
    const provider = new RazorpayPaymentProvider(
      {
        supabaseAdmin: client,
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
        fetchImpl,
      },
      "CONNECTED",
    );
    const result = await provider.getPaymentRequestStatus("plink_abc");
    assert.equal(result.status, "CAPTURED");
    assert.equal(result.amountPaidMinorUnits, 50000);
  });
});
