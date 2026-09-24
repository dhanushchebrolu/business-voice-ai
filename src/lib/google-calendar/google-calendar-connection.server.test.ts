import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  completeGoogleCalendarOAuth,
  selectCalendarForConnection,
  disconnectGoogleCalendarConnection,
  getCalendarProviderForConnection,
  GoogleCalendarConnectionError,
} from "./google-calendar-connection.server.ts";
import { encryptCredential } from "./google-calendar-crypto.server.ts";

const CRYPTO_KEY = "GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY";
const CONFIG_VARS = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
] as const;
const originalValues: Record<string, string | undefined> = {};

beforeEach(() => {
  originalValues[CRYPTO_KEY] = process.env[CRYPTO_KEY];
  process.env[CRYPTO_KEY] = randomBytes(32).toString("base64");
  for (const key of CONFIG_VARS) {
    originalValues[key] = process.env[key];
    process.env[key] = `test-${key.toLowerCase()}`;
  }
});

afterEach(() => {
  for (const key of [CRYPTO_KEY, ...CONFIG_VARS]) {
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

describe("completeGoogleCalendarOAuth", () => {
  test("exchanges the code, reads the account, and stores an encrypted refresh token with NEEDS_CALENDAR_SELECTION status", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "upsert.single",
        result: { data: { id: "conn-1" }, error: null },
      },
    ]);
    const fetchImpl = fakeFetchSequence([
      {
        status: 200,
        body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 },
      },
      { status: 200, body: { id: "google-acct-1", email: "biz@example.com" } },
    ]);

    const result = await completeGoogleCalendarOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-1", code: "auth-code" },
      fetchImpl,
    );

    assert.deepEqual(result, { connectionId: "conn-1" });
    const upsertCall = calls[0]!;
    const payload = upsertCall.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "NEEDS_CALENDAR_SELECTION");
    assert.equal(payload["google_email"], "biz@example.com");
    assert.equal(payload["organization_id"], "org-1");
    assert.equal(payload["business_id"], "biz-1");
    // Never the plaintext refresh token, always ciphertext.
    assert.doesNotMatch(String(payload["encrypted_credentials"]), /refresh-1/);
    assert.match(String(payload["encrypted_credentials"]), /^google_cal_cred\.v1\./);
  });

  test("fails clearly when Google Calendar is not configured on this deployment", async () => {
    delete process.env["GOOGLE_CALENDAR_CLIENT_ID"];
    const { client } = makeFakeSupabase([]);
    await assert.rejects(
      () =>
        completeGoogleCalendarOAuth(client, {
          organizationId: "org-1",
          businessId: "biz-1",
          code: "c",
        }),
      (err: unknown) => {
        assert.ok(err instanceof GoogleCalendarConnectionError);
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
        completeGoogleCalendarOAuth(
          client,
          { organizationId: "org-1", businessId: "biz-1", code: "bad-code" },
          fetchImpl,
        ),
      (err: unknown) => {
        assert.ok(err instanceof GoogleCalendarConnectionError);
        assert.equal(err.code, "OAUTH_FAILED");
        return true;
      },
    );
  });
});

describe("selectCalendarForConnection", () => {
  test("updates the chosen calendar and marks the connection CONNECTED", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-1" }, error: null },
      },
      { table: "google_calendar_connections", op: "update", result: { error: null } },
    ]);
    await selectCalendarForConnection(client, {
      organizationId: "org-1",
      connectionId: "conn-1",
      calendarId: "clinic-cal",
      calendarName: "Clinic Appointments",
    });
    const updateCall = calls[1]!;
    const payload = updateCall.args[0] as Record<string, unknown>;
    assert.equal(payload["calendar_id"], "clinic-cal");
    assert.equal(payload["status"], "CONNECTED");
  });

  test("refuses to select a calendar on a connection belonging to a different organization", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-OTHER" }, error: null },
      },
    ]);
    await assert.rejects(
      () =>
        selectCalendarForConnection(client, {
          organizationId: "org-1",
          connectionId: "conn-1",
          calendarId: "x",
          calendarName: "x",
        }),
      GoogleCalendarConnectionError,
    );
  });
});

describe("disconnectGoogleCalendarConnection", () => {
  test("clears the stored credential and marks DISCONNECTED, without deleting the row", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-1" }, error: null },
      },
      { table: "google_calendar_connections", op: "update", result: { error: null } },
    ]);
    await disconnectGoogleCalendarConnection(client, {
      organizationId: "org-1",
      connectionId: "conn-1",
    });
    const payload = calls[1]!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "DISCONNECTED");
    assert.equal(payload["encrypted_credentials"], null);
  });

  test("refuses to disconnect a connection belonging to a different organization", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-OTHER" }, error: null },
      },
    ]);
    await assert.rejects(
      () =>
        disconnectGoogleCalendarConnection(client, {
          organizationId: "org-1",
          connectionId: "conn-1",
        }),
      GoogleCalendarConnectionError,
    );
  });
});

describe("getCalendarProviderForConnection", () => {
  test("decrypts the stored refresh token, refreshes, and returns a provider scoped to the selected calendar", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh-token" }));
    const { client } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            status: "CONNECTED",
            calendar_id: "clinic-cal",
            encrypted_credentials: encrypted,
          },
          error: null,
        },
      },
      { table: "google_calendar_connections", op: "update", result: { error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } },
    ]);

    const { provider, calendarId } = await getCalendarProviderForConnection(
      client,
      "conn-1",
      fetchImpl,
    );
    assert.equal(calendarId, "clinic-cal");
    assert.ok(provider);
  });

  test("refuses to mint a token for a disconnected connection", async () => {
    const { client } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            status: "DISCONNECTED",
            calendar_id: null,
            encrypted_credentials: null,
          },
          error: null,
        },
      },
    ]);
    await assert.rejects(
      () => getCalendarProviderForConnection(client, "conn-1"),
      (err: unknown) => {
        assert.ok(err instanceof GoogleCalendarConnectionError);
        assert.equal(err.code, "NEEDS_REAUTH");
        return true;
      },
    );
  });

  test("marks the connection NEEDS_REAUTH when Google reports the refresh token is invalid/revoked", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "revoked-token" }));
    const { client, calls } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            status: "CONNECTED",
            calendar_id: "clinic-cal",
            encrypted_credentials: encrypted,
          },
          error: null,
        },
      },
      { table: "google_calendar_connections", op: "update", result: { error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([{ status: 400, body: { error: "invalid_grant" } }]);

    await assert.rejects(
      () => getCalendarProviderForConnection(client, "conn-1", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof GoogleCalendarConnectionError);
        assert.equal(err.code, "NEEDS_REAUTH");
        return true;
      },
    );
    const updatePayload = calls[1]!.args[0] as Record<string, unknown>;
    assert.equal(updatePayload["status"], "NEEDS_REAUTH");
  });

  test("never leaks the plaintext refresh token into a thrown error message", async () => {
    const encrypted = encryptCredential(
      JSON.stringify({ refreshToken: "must-not-leak-token-xyz" }),
    );
    const { client } = makeFakeSupabase([
      {
        table: "google_calendar_connections",
        op: "select.maybeSingle",
        result: {
          data: {
            id: "conn-1",
            status: "CONNECTED",
            calendar_id: "clinic-cal",
            encrypted_credentials: encrypted,
          },
          error: null,
        },
      },
      { table: "google_calendar_connections", op: "update", result: { error: null } },
    ]);
    const fetchImpl = fakeFetchSequence([{ status: 400, body: { error: "invalid_grant" } }]);

    try {
      await getCalendarProviderForConnection(client, "conn-1", fetchImpl);
      assert.fail("expected getCalendarProviderForConnection to throw");
    } catch (err) {
      assert.doesNotMatch((err as Error).message, /must-not-leak-token-xyz/);
    }
  });
});
