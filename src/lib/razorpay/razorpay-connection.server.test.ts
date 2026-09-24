import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  completeRazorpayOAuth,
  disconnectRazorpayConnection,
  verifyRazorpayConnection,
  getValidRazorpayAccessToken,
  RazorpayConnectionError,
} from "./razorpay-connection.server.ts";
import { encryptCredential } from "./razorpay-crypto.server.ts";

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

/** Minimal scripted fake Supabase client — records every call, returns canned results per table+op in call order. */
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
        single: () => Promise.resolve(next(table, "upsert.single", filters)),
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

describe("completeRazorpayOAuth", () => {
  test("exchanges the code and stores an encrypted credential with CONNECTED status", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "upsert.single",
        result: { data: { id: "conn-1" }, error: null },
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

    const result = await completeRazorpayOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-1", code: "auth-code" },
      fetchImpl,
    );

    assert.deepEqual(result, { connectionId: "conn-1" });
    const upsertCall = calls[0]!;
    const payload = upsertCall.args[0] as Record<string, unknown>;
    assert.equal(payload["connection_status"], "CONNECTED");
    assert.equal(payload["razorpay_account_id"], "acc_ABC123");
    assert.equal(payload["organization_id"], "org-1");
    assert.equal(payload["business_id"], "biz-1");
    // Never the plaintext access/refresh token, always ciphertext.
    assert.doesNotMatch(String(payload["encrypted_credentials"]), /access-1/);
    assert.doesNotMatch(String(payload["encrypted_credentials"]), /refresh-1/);
    assert.match(String(payload["encrypted_credentials"]), /^razorpay_cred\.v1\./);
  });

  test("fails clearly when Razorpay is not configured on this deployment", async () => {
    delete process.env["RAZORPAY_CLIENT_ID"];
    const { client } = makeFakeSupabase([]);
    await assert.rejects(
      () =>
        completeRazorpayOAuth(client, {
          organizationId: "org-1",
          businessId: "biz-1",
          code: "c",
        }),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayConnectionError);
        assert.equal(err.code, "NOT_CONFIGURED");
        return true;
      },
    );
  });

  test("fails when the authorization code exchange itself fails", async () => {
    const { client } = makeFakeSupabase([]);
    const fetchImpl = fakeFetchSequence([{ status: 400, body: { error: "invalid_grant" } }]);
    await assert.rejects(
      () =>
        completeRazorpayOAuth(
          client,
          { organizationId: "org-1", businessId: "biz-1", code: "bad-code" },
          fetchImpl,
        ),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayConnectionError);
        assert.equal(err.code, "OAUTH_FAILED");
        return true;
      },
    );
  });
});

describe("disconnectRazorpayConnection", () => {
  test("clears the stored credential and marks DISCONNECTED, without deleting the row", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-1" }, error: null },
      },
      { table: "razorpay_connections", op: "update", result: { error: null } },
    ]);
    await disconnectRazorpayConnection(client, {
      organizationId: "org-1",
      connectionId: "conn-1",
    });
    const payload = calls[1]!.args[0] as Record<string, unknown>;
    assert.equal(payload["connection_status"], "DISCONNECTED");
    assert.equal(payload["encrypted_credentials"], null);
    // Non-sensitive historical fields (business_name etc.) are not in the
    // update payload at all — they are preserved, not cleared.
    assert.equal("business_name" in payload, false);
  });

  test("refuses to disconnect a connection belonging to a different organization", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-OTHER" }, error: null },
      },
    ]);
    await assert.rejects(
      () =>
        disconnectRazorpayConnection(client, {
          organizationId: "org-1",
          connectionId: "conn-1",
        }),
      RazorpayConnectionError,
    );
  });
});

describe("getValidRazorpayAccessToken", () => {
  test("reuses a still-valid cached access token without a network call", async () => {
    const encrypted = encryptCredential(
      JSON.stringify({ accessToken: "cached-access", refreshToken: "stored-refresh" }),
    );
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            connection_status: "CONNECTED",
            encrypted_credentials: encrypted,
            token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          error: null,
        },
      },
    ]);
    let fetchCalled = false;
    const fetchImpl: typeof fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const token = await getValidRazorpayAccessToken(client, "conn-1", fetchImpl);
    assert.equal(token, "cached-access");
    assert.equal(fetchCalled, false);
  });

  test("refreshes an expired token using the stored refresh token", async () => {
    const encrypted = encryptCredential(
      JSON.stringify({ accessToken: "old-access", refreshToken: "stored-refresh" }),
    );
    const { client, calls } = makeFakeSupabase([
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
    const fetchImpl = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } },
    ]);

    const token = await getValidRazorpayAccessToken(client, "conn-1", fetchImpl);
    assert.equal(token, "fresh-access");
    const updatePayload = calls[1]!.args[0] as Record<string, unknown>;
    assert.doesNotMatch(String(updatePayload["encrypted_credentials"]), /fresh-access/);
  });

  test("marks REAUTH_REQUIRED when the token is expired and no refresh token is stored", async () => {
    const encrypted = encryptCredential(JSON.stringify({ accessToken: "old-access" }));
    const { client, calls } = makeFakeSupabase([
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
    await assert.rejects(
      () => getValidRazorpayAccessToken(client, "conn-1"),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayConnectionError);
        assert.equal(err.code, "REAUTH_REQUIRED");
        return true;
      },
    );
    const updatePayload = calls[1]!.args[0] as Record<string, unknown>;
    assert.equal(updatePayload["connection_status"], "REAUTH_REQUIRED");
  });

  test("marks REAUTH_REQUIRED when Razorpay reports the refresh token is invalid/revoked (401)", async () => {
    const encrypted = encryptCredential(
      JSON.stringify({ accessToken: "old-access", refreshToken: "revoked-token" }),
    );
    const { client, calls } = makeFakeSupabase([
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

    await assert.rejects(
      () => getValidRazorpayAccessToken(client, "conn-1", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayConnectionError);
        assert.equal(err.code, "REAUTH_REQUIRED");
        return true;
      },
    );
    const updatePayload = calls[1]!.args[0] as Record<string, unknown>;
    assert.equal(updatePayload["connection_status"], "REAUTH_REQUIRED");
  });

  test("rejects for a disconnected connection without any network call", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            connection_status: "DISCONNECTED",
            encrypted_credentials: null,
            token_expires_at: null,
          },
          error: null,
        },
      },
    ]);
    let fetchCalled = false;
    const fetchImpl: typeof fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => getValidRazorpayAccessToken(client, "conn-1", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayConnectionError);
        assert.equal(err.code, "REAUTH_REQUIRED");
        return true;
      },
    );
    assert.equal(fetchCalled, false);
  });

  test("never leaks the plaintext refresh token into a thrown error message", async () => {
    const encrypted = encryptCredential(
      JSON.stringify({ accessToken: "old-access", refreshToken: "must-not-leak-token-xyz" }),
    );
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
    const fetchImpl = fakeFetchSequence([{ status: 400, body: { error: "invalid_grant" } }]);

    try {
      await getValidRazorpayAccessToken(client, "conn-1", fetchImpl);
      assert.fail("expected getValidRazorpayAccessToken to throw");
    } catch (err) {
      assert.doesNotMatch((err as Error).message, /must-not-leak-token-xyz/);
    }
  });
});

describe("verifyRazorpayConnection", () => {
  test("returns DISCONNECTED immediately without any network call", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: { id: "conn-1", organization_id: "org-1", connection_status: "DISCONNECTED" },
          error: null,
        },
      },
    ]);
    let fetchCalled = false;
    const fetchImpl: typeof fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await verifyRazorpayConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      fetchImpl,
    );
    assert.deepEqual(result, { status: "DISCONNECTED" });
    assert.equal(fetchCalled, false);
  });

  test("returns CONNECTED and persists last_verified_at when the token is still valid", async () => {
    const encrypted = encryptCredential(
      JSON.stringify({ accessToken: "cached-access", refreshToken: "stored-refresh" }),
    );
    const { client, calls } = makeFakeSupabase([
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
            token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          error: null,
        },
      },
      { table: "razorpay_connections", op: "update", result: { error: null } },
    ]);
    const result = await verifyRazorpayConnection(client, {
      organizationId: "org-1",
      connectionId: "conn-1",
    });
    assert.deepEqual(result, { status: "CONNECTED" });
    const updatePayload = calls[2]!.args[0] as Record<string, unknown>;
    assert.equal(updatePayload["connection_status"], "CONNECTED");
    assert.ok(updatePayload["last_verified_at"]);
  });

  test("returns REAUTH_REQUIRED when the underlying token refresh needs re-auth", async () => {
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
    const result = await verifyRazorpayConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      fetchImpl,
    );
    assert.deepEqual(result, { status: "REAUTH_REQUIRED" });
  });

  test("returns ERROR and persists ERROR status when Razorpay is unavailable (never a fake CONNECTED)", async () => {
    const encrypted = encryptCredential(
      JSON.stringify({ accessToken: "old-access", refreshToken: "stored-refresh" }),
    );
    const { client, calls } = makeFakeSupabase([
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
      { table: "razorpay_connections", op: "update", result: { error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([{ status: 503, body: {} }]);
    const result = await verifyRazorpayConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      fetchImpl,
    );
    assert.deepEqual(result, { status: "ERROR" });
    // getValidRazorpayAccessToken records a non-fatal last_error first
    // (calls[2]), then verifyRazorpayConnection itself persists the
    // ERROR connection_status (calls[3]).
    const updatePayload = calls[3]!.args[0] as Record<string, unknown>;
    assert.equal(updatePayload["connection_status"], "ERROR");
  });

  test("refuses to verify a connection belonging to a different organization", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "razorpay_connections",
        op: "select.maybeSingle",
        result: {
          data: { id: "conn-1", organization_id: "org-OTHER", connection_status: "CONNECTED" },
          error: null,
        },
      },
    ]);
    await assert.rejects(
      () => verifyRazorpayConnection(client, { organizationId: "org-1", connectionId: "conn-1" }),
      RazorpayConnectionError,
    );
  });
});
