import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_STATE_COOKIE_PATH,
  clearOAuthStateCookieHeader,
  googleOAuthStateCookieOptions,
  oauthStateMatchesCookie,
  readCookieValue,
} from "./oauth-state-cookie.server.ts";
import { CalendarAccessError, requireCalendarManager } from "./calendar-access.server.ts";
import {
  completeGoogleCalendarOAuth,
  disconnectGoogleCalendarConnection,
  isGoogleAccountUsedElsewhere,
  isSameGoogleAccount,
  listWritableCalendarsForConnection,
  testGoogleCalendarConnection,
} from "./google-calendar-connection.server.ts";
import { encryptCredential, decryptCredential } from "./google-calendar-crypto.server.ts";
import { revokeGoogleToken } from "./google-oauth.server.ts";
import { handleWebhookNotification } from "./google-calendar-sync.server.ts";
import {
  googleCalendarCallbackMessage,
  googleCalendarIssueCode,
  googleCalendarIssueMessage,
} from "./google-calendar-errors.ts";
import { GoogleCalendarProvider } from "../calendar/google-calendar-provider.server.ts";
import { calendarAllowsWrites } from "../calendar/calendar-provider.ts";
import { describeGoogleCalendarCardState } from "../../components/integrations/google-calendar-card-state.ts";

const here = dirname(fileURLToPath(import.meta.url));

const CRYPTO_KEY = "GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY";
const CONFIG_VARS = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved[CRYPTO_KEY] = process.env[CRYPTO_KEY];
  process.env[CRYPTO_KEY] = randomBytes(32).toString("base64");
  for (const key of CONFIG_VARS) {
    saved[key] = process.env[key];
    process.env[key] = `test-${key.toLowerCase()}`;
  }
});
afterEach(() => {
  for (const key of [CRYPTO_KEY, ...CONFIG_VARS]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// ------------------------------------------------------------------
// Fakes
// ------------------------------------------------------------------

interface Call {
  table: string;
  kind: "select" | "update" | "upsert";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeFakeSupabase(respond: (call: Call) => { data?: unknown; error?: unknown }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, kind: "select", filters: {} };
      const run = () => {
        calls.push(call);
        const r = respond(call);
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        update(payload: Record<string, unknown>) {
          call.kind = "update";
          call.payload = payload;
          return chain;
        },
        upsert(payload: Record<string, unknown>) {
          call.kind = "upsert";
          call.payload = payload;
          return chain;
        },
        eq(col: string, val: unknown) {
          call.filters[col] = val;
          return chain;
        },
        neq(col: string, val: unknown) {
          call.filters[`${col}!=`] = val;
          return chain;
        },
        not(col: string, op: string, val: unknown) {
          call.filters[`${col}:not`] = `${op}.${String(val)}`;
          return chain;
        },
        limit: () => chain,
        maybeSingle: run,
        single: run,
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          return run().then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

/** The "does another connection use this Google account?" lookup. */
function isSharedAccountLookup(call: Call): boolean {
  return call.kind === "select" && "id!=" in call.filters;
}
/** The guarded "clear this connection's credential" update. */
function isGuardedClear(call: Call): boolean {
  return call.kind === "update" && "encrypted_credentials:not" in call.filters;
}

interface FetchCall {
  url: string;
  method: string;
  body: string;
}

/** Routes by URL substring; records every request. */
function routedFetch(routes: [string, (call: FetchCall) => { status: number; body?: unknown }][]) {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const route = routes.find(([fragment]) => call.url.includes(fragment));
    if (!route) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    const { status, body } = route[1](call);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = "oauth2.googleapis.com/token";
const REVOKE = "oauth2.googleapis.com/revoke";
const USERINFO = "/oauth2/v2/userinfo";
const CAL_LIST = "/users/me/calendarList";

// ------------------------------------------------------------------
// A. OAuth state bound to the browser
// ------------------------------------------------------------------

describe("OAuth state cookie", () => {
  const state = "a".repeat(43);

  test("is HttpOnly, Secure, SameSite=Lax, short-lived and scoped to the callback path", () => {
    assert.deepEqual(googleOAuthStateCookieOptions, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/public/integrations/google-calendar",
      maxAge: 600,
    });
  });

  test("matches only the exact state this browser was given", () => {
    const header = `other=1; ${GOOGLE_OAUTH_STATE_COOKIE}=${state}; theme=dark`;
    assert.equal(readCookieValue(header, GOOGLE_OAUTH_STATE_COOKIE), state);
    assert.equal(oauthStateMatchesCookie(header, state), true);
    assert.equal(oauthStateMatchesCookie(header, "b".repeat(43)), false, "different state");
    assert.equal(oauthStateMatchesCookie(header, state.slice(1)), false, "different length");
    assert.equal(oauthStateMatchesCookie(null, state), false, "no cookie (other browser)");
    assert.equal(oauthStateMatchesCookie("other=1", state), false, "cookie missing");
    assert.equal(oauthStateMatchesCookie(header, null), false, "no state param");
    assert.equal(oauthStateMatchesCookie(`${GOOGLE_OAUTH_STATE_COOKIE}=`, ""), false);
  });

  test("a look-alike cookie name does not count", () => {
    assert.equal(oauthStateMatchesCookie(`x${GOOGLE_OAUTH_STATE_COOKIE}=${state}`, state), false);
  });

  test("the clearing header expires the same cookie on the same path", () => {
    const header = clearOAuthStateCookieHeader();
    assert.match(header, new RegExp(`^${GOOGLE_OAUTH_STATE_COOKIE}=;`));
    assert.match(header, new RegExp(`Path=${GOOGLE_OAUTH_STATE_COOKIE_PATH}`));
    assert.match(header, /Max-Age=0/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
  });

  test("the callback checks the cookie before consuming the state or exchanging the code, and always clears it", () => {
    const src = readFileSync(
      join(here, "../../routes/api/public/integrations/google-calendar/callback.ts"),
      "utf8",
    ).replace(/\/\*\*[\s\S]*?\*\//g, "");
    const cookieIdx = src.indexOf("oauthStateMatchesCookie(");
    const consumeIdx = src.indexOf("consumeOAuthState(");
    const exchangeIdx = src.indexOf("completeGoogleCalendarOAuth(");
    assert.ok(cookieIdx > -1 && cookieIdx < consumeIdx && consumeIdx < exchangeIdx);
    assert.match(src, /request\.headers\.get\("cookie"\)/);
    assert.match(src, /response\.headers\.append\("Set-Cookie", clearOAuthStateCookieHeader\(\)\)/);
  });

  test("connectGoogleCalendar sets the cookie with the state it issues", () => {
    const src = readFileSync(join(here, "../google-calendar.functions.ts"), "utf8");
    assert.match(
      src,
      /setCookie\(GOOGLE_OAUTH_STATE_COOKIE, state, \{ \.\.\.googleOAuthStateCookieOptions \}\)/,
    );
  });
});

// ------------------------------------------------------------------
// A. Owner/admin enforcement and org derivation
// ------------------------------------------------------------------

describe("requireCalendarManager", () => {
  function db(opts: { role?: string | null; connectionOrg?: string; businessOrg?: string }) {
    return makeFakeSupabase((call) => {
      if (call.table === "google_calendar_connections") {
        return opts.connectionOrg
          ? { data: { id: "conn-1", organization_id: opts.connectionOrg, business_id: "biz-1" } }
          : {};
      }
      if (call.table === "businesses") {
        return opts.businessOrg ? { data: { id: "biz-1", organization_id: opts.businessOrg } } : {};
      }
      if (call.table === "organization_members") {
        return opts.role ? { data: { role: opts.role } } : {};
      }
      throw new Error(`unexpected table ${call.table}`);
    });
  }

  for (const role of ["owner", "admin"]) {
    test(`${role} may manage; the org comes from the target row`, async () => {
      const { client, calls } = db({ role, connectionOrg: "org-1" });
      const scope = await requireCalendarManager(client, "user-1", { connectionId: "conn-1" });
      assert.deepEqual(scope, {
        organizationId: "org-1",
        businessId: "biz-1",
        connectionId: "conn-1",
      });
      const member = calls.find((c) => c.table === "organization_members")!;
      assert.deepEqual(member.filters, { organization_id: "org-1", user_id: "user-1" });
    });
  }

  for (const role of ["manager", "staff", "viewer"]) {
    test(`${role} is refused (connect, select, test, reconnect, disconnect)`, async () => {
      for (const target of [{ businessId: "biz-1" }, { connectionId: "conn-1" }]) {
        const { client } = db({ role, connectionOrg: "org-1", businessOrg: "org-1" });
        await assert.rejects(
          () => requireCalendarManager(client, "user-1", target),
          (err: unknown) => err instanceof CalendarAccessError && err.code === "FORBIDDEN",
        );
      }
    });
  }

  test("a business or connection in an organization the user is not in looks exactly like a missing one", async () => {
    const otherTenant = db({ role: null, businessOrg: "org-OTHER", connectionOrg: "org-OTHER" });
    for (const target of [{ businessId: "biz-1" }, { connectionId: "conn-1" }]) {
      await assert.rejects(
        () => requireCalendarManager(otherTenant.client, "user-1", target),
        (err: unknown) => err instanceof CalendarAccessError && err.code === "NOT_FOUND",
      );
    }
    const missing = db({ role: "owner" });
    await assert.rejects(
      () => requireCalendarManager(missing.client, "user-1", { businessId: "nope" }),
      (err: unknown) => err instanceof CalendarAccessError && err.code === "NOT_FOUND",
    );
  });

  test("every Google Calendar mutation server function goes through requireManager", () => {
    const src = readFileSync(join(here, "../google-calendar.functions.ts"), "utf8");
    for (const fn of [
      "connectGoogleCalendar",
      "listGoogleCalendars",
      "selectGoogleCalendar",
      "testGoogleCalendarConnection",
      "disconnectGoogleCalendar",
    ]) {
      const start = src.indexOf(`export const ${fn} =`);
      assert.ok(start > -1, fn);
      const next = src.indexOf("export const ", start + 1);
      const body = src.slice(start, next === -1 ? undefined : next);
      assert.match(body, /requireManager\(supabaseAdmin, context\.userId,/, fn);
      assert.doesNotMatch(body, /resolveOrgId\(/, `${fn} must not use first-membership org`);
    }
  });
});

// ------------------------------------------------------------------
// A. Calendar write permissions
// ------------------------------------------------------------------

describe("selected-calendar write permission", () => {
  test("only owner/writer calendars are writable", () => {
    assert.equal(calendarAllowsWrites({ accessRole: "owner" }), true);
    assert.equal(calendarAllowsWrites({ accessRole: "writer" }), true);
    assert.equal(calendarAllowsWrites({ accessRole: "reader" }), false);
    assert.equal(calendarAllowsWrites({ accessRole: "freeBusyReader" }), false);
    assert.equal(calendarAllowsWrites({}), false);
  });

  test("the calendar list offered for selection only contains writable calendars, even before one is chosen", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "r" }));
    const { client } = makeFakeSupabase((call) => {
      if (call.kind === "select") {
        return {
          data: {
            id: "conn-1",
            organization_id: "org-1",
            status: "NEEDS_CALENDAR_SELECTION",
            calendar_id: null,
            encrypted_credentials: encrypted,
          },
        };
      }
      return {};
    });
    const { impl } = routedFetch([
      [TOKEN, () => ({ status: 200, body: { access_token: "a", expires_in: 3600 } })],
      [
        CAL_LIST,
        () => ({
          status: 200,
          body: {
            items: [
              { id: "me@example.com", summary: "Me", primary: true, accessRole: "owner" },
              { id: "team", summary: "Team", accessRole: "writer" },
              { id: "holidays", summary: "Holidays", accessRole: "reader" },
            ],
          },
        }),
      ],
    ]);
    const calendars = await listWritableCalendarsForConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      impl,
    );
    assert.deepEqual(
      calendars.map((c) => c.id),
      ["me@example.com", "team"],
    );
  });
});

// ------------------------------------------------------------------
// A. Reconnecting a different Google account
// ------------------------------------------------------------------

describe("account switching on reconnect", () => {
  function reconnect(
    existing: Record<string, unknown> | null,
    primaryId: string | null,
    previousAccountUsedElsewhere = false,
  ) {
    const { client, calls } = makeFakeSupabase((call) => {
      if (isSharedAccountLookup(call)) {
        return { data: previousAccountUsedElsewhere ? [{ id: "conn-other-business" }] : [] };
      }
      if (call.kind === "select") return { data: existing };
      if (call.kind === "upsert") return { data: { id: "conn-1" } };
      return {};
    });
    const { impl, calls: fetchCalls } = routedFetch([
      [
        TOKEN,
        () => ({
          status: 200,
          body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
        }),
      ],
      // No email/openid scope is requested, so userinfo refuses.
      [USERINFO, () => ({ status: 401, body: { error: "insufficient scope" } })],
      [
        CAL_LIST,
        () => ({
          status: 200,
          body: { items: primaryId ? [{ id: primaryId, primary: true, accessRole: "owner" }] : [] },
        }),
      ],
      [REVOKE, () => ({ status: 200 })],
    ]);
    return { client, calls, impl, fetchCalls };
  }
  const oldRow = (overrides: Record<string, unknown> = {}) => ({
    id: "conn-1",
    google_account_id: null,
    google_email: "old@example.com",
    calendar_id: "old-cal",
    encrypted_credentials: encryptCredential(JSON.stringify({ refreshToken: "old-refresh" })),
    ...overrides,
  });

  test("the account email comes from the primary calendar id (no extra OAuth scope)", async () => {
    const { client, calls, impl } = reconnect(null, "Owner@Example.com");
    await completeGoogleCalendarOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-1", code: "c" },
      impl,
    );
    const upsert = calls.find((c) => c.kind === "upsert")!;
    assert.equal(upsert.payload!["google_email"], "owner@example.com");
  });

  test("a primary calendar id that is not email-shaped is never shown as the account", async () => {
    const { client, calls, impl } = reconnect(null, "not-an-email");
    await completeGoogleCalendarOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-1", code: "c" },
      impl,
    );
    assert.equal(calls.find((c) => c.kind === "upsert")!.payload!["google_email"], null);
  });

  test("a different account clears the stale calendar, sync token and channel, and revokes the old grant", async () => {
    const { client, calls, impl, fetchCalls } = reconnect(oldRow(), "new@example.com");
    const result = await completeGoogleCalendarOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-1", code: "c" },
      impl,
    );
    assert.equal(result.accountChanged, true);
    assert.equal(result.status, "NEEDS_CALENDAR_SELECTION");
    const payload = calls.find((c) => c.kind === "upsert")!.payload!;
    for (const field of [
      "calendar_id",
      "calendar_name",
      "sync_token",
      "channel_id",
      "channel_resource_id",
      "channel_expiration",
      "channel_token",
    ]) {
      assert.equal(payload[field], null, `${field} cleared`);
    }
    assert.equal(payload["google_email"], "new@example.com");
    const stored = JSON.parse(decryptCredential(String(payload["encrypted_credentials"])));
    assert.equal(stored.refreshToken, "new-refresh");
    const revoke = fetchCalls.find((c) => c.url.includes(REVOKE))!;
    assert.match(revoke.body, /token=old-refresh/, "the OLD account's grant is revoked");
  });

  test("the same account keeps its calendar and goes straight back to CONNECTED, with no revoke", async () => {
    const { client, calls, impl, fetchCalls } = reconnect(oldRow(), "OLD@example.com");
    const result = await completeGoogleCalendarOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-1", code: "c" },
      impl,
    );
    assert.deepEqual(result, {
      connectionId: "conn-1",
      accountChanged: false,
      status: "CONNECTED",
    });
    const payload = calls.find((c) => c.kind === "upsert")!.payload!;
    assert.equal("calendar_id" in payload, false, "calendar kept");
    assert.equal("channel_id" in payload, false, "channel kept");
    assert.equal(
      fetchCalls.some((c) => c.url.includes(REVOKE)),
      false,
      "revoking would also kill the new grant for the same account",
    );
  });

  test("an unverifiable identity is treated as a switch (calendar cleared) but nothing is revoked on a guess", async () => {
    const { client, calls, impl, fetchCalls } = reconnect(oldRow(), null);
    const result = await completeGoogleCalendarOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-1", code: "c" },
      impl,
    );
    assert.equal(result.status, "NEEDS_CALENDAR_SELECTION");
    assert.equal(calls.find((c) => c.kind === "upsert")!.payload!["calendar_id"], null);
    assert.equal(
      fetchCalls.some((c) => c.url.includes(REVOKE)),
      false,
    );
  });

  test("isSameGoogleAccount prefers the stable account id and is case-insensitive on email", () => {
    assert.equal(
      isSameGoogleAccount(
        { google_account_id: "1", google_email: "a@x.com" },
        { googleAccountId: "2", email: "a@x.com" },
      ),
      false,
    );
    assert.equal(
      isSameGoogleAccount(
        { google_account_id: null, google_email: "A@x.com" },
        { googleAccountId: null, email: "a@x.com" },
      ),
      true,
    );
    assert.equal(
      isSameGoogleAccount(
        { google_account_id: null, google_email: null },
        { googleAccountId: null, email: "a@x.com" },
      ),
      false,
    );
  });
});

// ------------------------------------------------------------------
// B. Disconnect: stop channel, revoke, delete credentials
// ------------------------------------------------------------------

describe("disconnect", () => {
  function connectedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "conn-1",
      organization_id: "org-1",
      encrypted_credentials: encryptCredential(JSON.stringify({ refreshToken: "live-refresh" })),
      channel_id: "ch-1",
      channel_resource_id: "res-1",
      google_email: "owner@example.com",
      google_account_id: null,
      ...overrides,
    };
  }

  test("stops the push channel, revokes the Google grant, then deletes every credential and channel field", async () => {
    const { client, calls } = makeFakeSupabase((call) => {
      if (isSharedAccountLookup(call)) return { data: [] };
      if (isGuardedClear(call)) return { data: [{ id: "conn-1" }] };
      return call.kind === "select" ? { data: connectedRow() } : {};
    });
    const { impl, calls: fetchCalls } = routedFetch([
      [TOKEN, () => ({ status: 200, body: { access_token: "a", expires_in: 3600 } })],
      ["/channels/stop", () => ({ status: 204 })],
      [REVOKE, () => ({ status: 200 })],
    ]);
    const result = await disconnectGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      impl,
    );
    assert.deepEqual(result, { channelStopped: true, revoked: true, revokeSkipped: null });
    const order = fetchCalls.map((c) =>
      c.url.includes("/channels/stop") ? "stop" : c.url.includes(REVOKE) ? "revoke" : "token",
    );
    assert.deepEqual(order, ["token", "stop", "revoke"]);
    assert.match(fetchCalls[2]!.body, /token=live-refresh/);

    const update = calls.find((c) => c.kind === "update")!.payload!;
    assert.equal(update["status"], "DISCONNECTED");
    for (const field of [
      "encrypted_credentials",
      "token_expires_at",
      "sync_token",
      "channel_id",
      "channel_resource_id",
      "channel_expiration",
      "channel_token",
    ]) {
      assert.equal(update[field], null, `${field} cleared`);
    }
  });

  test("Google being unreachable never blocks the local disconnect", async () => {
    const { client, calls } = makeFakeSupabase((call) => {
      if (isSharedAccountLookup(call)) return { data: [] };
      if (isGuardedClear(call)) return { data: [{ id: "conn-1" }] };
      return call.kind === "select" ? { data: connectedRow() } : {};
    });
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await disconnectGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      failing,
    );
    assert.deepEqual(result, { channelStopped: false, revoked: false, revokeSkipped: null });
    assert.equal(calls.find((c) => c.kind === "update")!.payload!["encrypted_credentials"], null);
  });

  test("another organization's connection is refused before anything is revoked", async () => {
    const { client } = makeFakeSupabase(() => ({
      data: connectedRow({ organization_id: "org-OTHER" }),
    }));
    const { impl, calls: fetchCalls } = routedFetch([]);
    await assert.rejects(() =>
      disconnectGoogleCalendarConnection(
        client,
        { organizationId: "org-1", connectionId: "conn-1" },
        impl,
      ),
    );
    assert.equal(fetchCalls.length, 0);
  });
});

// ------------------------------------------------------------------
// One Google account shared by several businesses: the grant is revoked
// only when the last connection using it goes away.
// ------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

/**
 * Small in-memory google_calendar_connections table that really applies
 * eq / neq / not-is-null filters, so concurrent operations interleave on
 * shared state the way they would against PostgREST.
 */
function makeConnectionsTable(rows: Row[]) {
  const table = rows.map((r) => ({ ...r }));
  const log: { kind: string; filters: [string, string, unknown][] }[] = [];
  const client = {
    from(name: string) {
      assert.equal(name, "google_calendar_connections");
      let kind: "select" | "update" = "select";
      let payload: Record<string, unknown> = {};
      const filters: [string, string, unknown][] = [];
      const matches = (row: Row) =>
        filters.every(([col, op, val]) =>
          op === "eq" ? row[col] === val : op === "neq" ? row[col] !== val : row[col] != null,
        );
      const run = async (single: boolean) => {
        await Promise.resolve(); // yield, so concurrent callers interleave
        log.push({ kind, filters: [...filters] });
        const hit = table.filter(matches);
        if (kind === "update") for (const row of hit) Object.assign(row, payload);
        const data = hit.map((r) => ({ ...r }));
        return { data: single ? (data[0] ?? null) : data, error: null };
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        update(p: Record<string, unknown>) {
          kind = "update";
          payload = p;
          return chain;
        },
        eq(col: string, val: unknown) {
          filters.push([col, "eq", val]);
          return chain;
        },
        neq(col: string, val: unknown) {
          filters.push([col, "neq", val]);
          return chain;
        },
        not(col: string, op: string, val: unknown) {
          assert.equal(`${op}.${String(val)}`, "is.null");
          filters.push([col, "notnull", null]);
          return chain;
        },
        limit: () => chain,
        maybeSingle: () => run(true),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          run(false).then(res, rej),
      };
      return chain;
    },
  };
  return { client: client as never, table, log };
}

describe("shared Google account across businesses", () => {
  const SHARED = "owner@clinic.example";
  const credential = (refreshToken: string) => encryptCredential(JSON.stringify({ refreshToken }));
  const connection = (id: string, org: string, overrides: Record<string, unknown> = {}): Row => ({
    id,
    organization_id: org,
    business_id: `biz-${id}`,
    status: "CONNECTED",
    google_email: SHARED,
    google_account_id: null,
    calendar_id: `cal-${id}`,
    encrypted_credentials: credential(`refresh-${id}`),
    channel_id: null,
    channel_resource_id: null,
    ...overrides,
  });
  const googleFetch = () =>
    routedFetch([
      [TOKEN, () => ({ status: 200, body: { access_token: "a", expires_in: 3600 } })],
      [REVOKE, () => ({ status: 200 })],
    ]);
  const revokes = (calls: FetchCall[]) => calls.filter((c) => c.url.includes(REVOKE));

  test("disconnecting one of two businesses on the same account removes only that connection and keeps the grant", async () => {
    // Branch A and branch B (even in different workspaces) share one Google account.
    const { client, table, log } = makeConnectionsTable([
      connection("conn-A", "org-1"),
      connection("conn-B", "org-2"),
    ]);
    const { impl, calls } = googleFetch();

    const result = await disconnectGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-A" },
      impl,
    );

    assert.deepEqual(result, {
      channelStopped: false,
      revoked: false,
      revokeSkipped: "account_in_use_elsewhere",
    });
    assert.equal(revokes(calls).length, 0, "the shared grant is never revoked");
    const [a, b] = table;
    assert.equal(a!["status"], "DISCONNECTED");
    assert.equal(a!["encrypted_credentials"], null, "A's own credential is still deleted");
    assert.equal(b!["status"], "CONNECTED", "B is untouched");
    assert.notEqual(b!["encrypted_credentials"], null);
    // The lookup excluded A itself and only counted rows still holding a credential.
    const lookup = log.find((l) => l.filters.some(([, op]) => op === "neq"))!;
    assert.deepEqual(lookup.filters, [
      ["google_email", "eq", SHARED],
      ["id", "neq", "conn-A"],
      ["encrypted_credentials", "notnull", null],
    ]);
  });

  test("disconnecting the final connection for the account revokes the grant", async () => {
    // B was already disconnected earlier (no credential left), so A is the last one.
    const { client, table } = makeConnectionsTable([
      connection("conn-A", "org-1"),
      connection("conn-B", "org-2", { status: "DISCONNECTED", encrypted_credentials: null }),
    ]);
    const { impl, calls } = googleFetch();

    const result = await disconnectGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-A" },
      impl,
    );

    assert.deepEqual(result, { channelStopped: false, revoked: true, revokeSkipped: null });
    assert.equal(revokes(calls).length, 1);
    assert.match(revokes(calls)[0]!.body, /token=refresh-conn-A/);
    assert.equal(table[0]!["encrypted_credentials"], null);
  });

  test("the same account matched by email in a different letter case still counts as shared", async () => {
    const { client } = makeConnectionsTable([
      connection("conn-A", "org-1", { google_email: "Owner@Clinic.Example" }),
      connection("conn-B", "org-1"),
    ]);
    const { impl, calls } = googleFetch();
    const result = await disconnectGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-A" },
      impl,
    );
    assert.equal(result.revokeSkipped, "account_in_use_elsewhere");
    assert.equal(revokes(calls).length, 0);
  });

  test("both businesses disconnecting at the same moment: both cleared, and the grant still ends up revoked", async () => {
    const { client, table } = makeConnectionsTable([
      connection("conn-A", "org-1"),
      connection("conn-B", "org-2"),
    ]);
    const { impl, calls } = googleFetch();

    const results = await Promise.all([
      disconnectGoogleCalendarConnection(
        client,
        { organizationId: "org-1", connectionId: "conn-A" },
        impl,
      ),
      disconnectGoogleCalendarConnection(
        client,
        { organizationId: "org-2", connectionId: "conn-B" },
        impl,
      ),
    ]);

    for (const row of table) {
      assert.equal(row["status"], "DISCONNECTED");
      assert.equal(row["encrypted_credentials"], null);
    }
    // Each call checks for other users AFTER deleting its own credential,
    // so at least one of them sees no remaining user and revokes; a
    // second revoke of an already-revoked grant is harmless.
    assert.ok(revokes(calls).length >= 1, "the grant is not left behind");
    assert.ok(results.some((r) => r.revoked));
  });

  test("two disconnects of the SAME connection: only the one that cleared the credential decides about revoking", async () => {
    const { client, table } = makeConnectionsTable([connection("conn-A", "org-1")]);
    const { impl, calls } = googleFetch();

    const results = await Promise.all([
      disconnectGoogleCalendarConnection(
        client,
        { organizationId: "org-1", connectionId: "conn-A" },
        impl,
      ),
      disconnectGoogleCalendarConnection(
        client,
        { organizationId: "org-1", connectionId: "conn-A" },
        impl,
      ),
    ]);

    assert.equal(table[0]!["encrypted_credentials"], null);
    assert.equal(revokes(calls).length, 1, "revoked exactly once");
    assert.deepEqual(results.map((r) => r.revokeSkipped).sort(), ["already_disconnected", null]);
  });

  test("a connection whose Google account was never identified keeps its grant (it cannot be proven unshared)", async () => {
    const { client, table } = makeConnectionsTable([
      connection("conn-A", "org-1", { google_email: null }),
    ]);
    const { impl, calls } = googleFetch();
    const result = await disconnectGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-A" },
      impl,
    );
    assert.deepEqual(result, {
      channelStopped: false,
      revoked: false,
      revokeSkipped: "account_unknown",
    });
    assert.equal(revokes(calls).length, 0);
    assert.equal(table[0]!["encrypted_credentials"], null);
  });

  test("if the shared-account lookup fails, the grant is kept (fail safe)", async () => {
    const used = await isGoogleAccountUsedElsewhere(
      {
        from: () => {
          const chain: Record<string, unknown> = {};
          for (const m of ["select", "eq", "neq", "not", "limit"]) chain[m] = () => chain;
          chain["then"] = (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: "db down" } }).then(res);
          return chain;
        },
      } as never,
      { excludeConnectionId: "conn-A", googleAccountId: null, googleEmail: SHARED },
    );
    assert.equal(used, true);
  });

  test("switching one business to a different account does not revoke the old account another business still uses", async () => {
    const existing = {
      id: "conn-A",
      google_account_id: null,
      google_email: SHARED,
      calendar_id: "cal-A",
      encrypted_credentials: credential("refresh-old"),
    };
    // Reuses the reconnect fixture shape: old account still connected to business B.
    const { client } = makeFakeSupabase((call) => {
      if (isSharedAccountLookup(call)) {
        assert.equal(call.filters["google_email"], SHARED);
        assert.equal(call.filters["id!="], "conn-A");
        return { data: [{ id: "conn-B" }] };
      }
      if (call.kind === "select") return { data: existing };
      if (call.kind === "upsert") return { data: { id: "conn-A" } };
      return {};
    });
    const { impl, calls } = routedFetch([
      [
        TOKEN,
        () => ({
          status: 200,
          body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
        }),
      ],
      [USERINFO, () => ({ status: 401 })],
      [
        CAL_LIST,
        () => ({
          status: 200,
          body: { items: [{ id: "new@example.com", primary: true, accessRole: "owner" }] },
        }),
      ],
      [REVOKE, () => ({ status: 200 })],
    ]);

    const result = await completeGoogleCalendarOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-A", code: "c" },
      impl,
    );
    assert.equal(result.accountChanged, true);
    assert.equal(revokes(calls).length, 0, "business B keeps working on the old account");
  });

  test("switching the last business off an account does revoke that old account's grant", async () => {
    const existing = {
      id: "conn-A",
      google_account_id: null,
      google_email: SHARED,
      calendar_id: "cal-A",
      encrypted_credentials: credential("refresh-old"),
    };
    const { client } = makeFakeSupabase((call) => {
      if (isSharedAccountLookup(call)) return { data: [] };
      if (call.kind === "select") return { data: existing };
      if (call.kind === "upsert") return { data: { id: "conn-A" } };
      return {};
    });
    const { impl, calls } = routedFetch([
      [
        TOKEN,
        () => ({
          status: 200,
          body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
        }),
      ],
      [USERINFO, () => ({ status: 401 })],
      [
        CAL_LIST,
        () => ({
          status: 200,
          body: { items: [{ id: "new@example.com", primary: true, accessRole: "owner" }] },
        }),
      ],
      [REVOKE, () => ({ status: 200 })],
    ]);
    await completeGoogleCalendarOAuth(
      client,
      { organizationId: "org-1", businessId: "biz-A", code: "c" },
      impl,
    );
    assert.equal(revokes(calls).length, 1);
    assert.match(revokes(calls)[0]!.body, /token=refresh-old/);
  });

  test("no token or credential is ever logged by disconnect or account switching", async () => {
    const logged: unknown[] = [];
    const orig = { info: console.info, warn: console.warn, error: console.error };
    console.info = console.warn = console.error = (...args: unknown[]) => logged.push(args);
    try {
      const shared = makeConnectionsTable([
        connection("conn-A", "org-1"),
        connection("conn-B", "org-2"),
      ]);
      await disconnectGoogleCalendarConnection(
        shared.client,
        { organizationId: "org-1", connectionId: "conn-A" },
        googleFetch().impl,
      );
      await disconnectGoogleCalendarConnection(
        shared.client,
        { organizationId: "org-2", connectionId: "conn-B" },
        googleFetch().impl,
      );
    } finally {
      Object.assign(console, orig);
    }
    const text = JSON.stringify(logged);
    assert.ok(logged.length > 0);
    assert.doesNotMatch(text, /refresh-conn|google_cal_cred|access_token|"a"|owner@clinic/);
  });
});

describe("revokeGoogleToken", () => {
  test("posts the token form-encoded to Google's revoke endpoint", async () => {
    const { impl, calls } = routedFetch([[REVOKE, () => ({ status: 200 })]]);
    assert.deepEqual(await revokeGoogleToken("tok-1", impl), {
      ok: true,
      alreadyInvalid: false,
      status: 200,
    });
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.body, "token=tok-1");
  });

  test("an already-revoked grant counts as success; other failures do not throw", async () => {
    const invalid = routedFetch([
      [REVOKE, () => ({ status: 400, body: { error: "invalid_token" } })],
    ]);
    assert.deepEqual(await revokeGoogleToken("t", invalid.impl), {
      ok: true,
      alreadyInvalid: true,
      status: 400,
    });
    const down = routedFetch([[REVOKE, () => ({ status: 503 })]]);
    assert.deepEqual(await revokeGoogleToken("t", down.impl), {
      ok: false,
      alreadyInvalid: false,
      status: 503,
    });
  });
});

// ------------------------------------------------------------------
// B. Test connection
// ------------------------------------------------------------------

describe("testGoogleCalendarConnection", () => {
  const encrypted = () => encryptCredential(JSON.stringify({ refreshToken: "r" }));
  function db(row: Record<string, unknown>) {
    return makeFakeSupabase((call) =>
      call.kind === "select"
        ? {
            data: {
              id: "conn-1",
              organization_id: "org-1",
              status: "CONNECTED",
              calendar_id: "clinic-cal",
              encrypted_credentials: encrypted(),
              ...row,
            },
          }
        : {},
    );
  }

  test("refreshes the token and reads free/busy for the selected calendar", async () => {
    const { client, calls } = db({ status: "ERROR" });
    const { impl, calls: fetchCalls } = routedFetch([
      [TOKEN, () => ({ status: 200, body: { access_token: "a", expires_in: 3600 } })],
      ["/freeBusy", () => ({ status: 200, body: { calendars: { "clinic-cal": { busy: [] } } } })],
    ]);
    const now = new Date("2030-10-14T10:00:00.000Z");
    const result = await testGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      impl,
      now,
    );
    assert.deepEqual(result, { ok: true, checkedAt: now.toISOString() });
    const freeBusy = JSON.parse(fetchCalls.find((c) => c.url.includes("/freeBusy"))!.body);
    assert.deepEqual(freeBusy.items, [{ id: "clinic-cal" }]);
    const last = calls.filter((c) => c.kind === "update").at(-1)!.payload!;
    assert.equal(last["status"], "CONNECTED");
    assert.equal(last["last_error"], null);
  });

  test("lost calendar access marks ERROR with a friendly message — never Google's raw text", async () => {
    const { client, calls } = db({});
    const { impl } = routedFetch([
      [TOKEN, () => ({ status: 200, body: { access_token: "a", expires_in: 3600 } })],
      [
        "/freeBusy",
        () => ({
          status: 403,
          body: { error: { code: 403, message: "RAW-GOOGLE-SECRET-DETAIL", errors: [] } },
        }),
      ],
    ]);
    const result = await testGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      impl,
    );
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /RAW-GOOGLE-SECRET-DETAIL/);
    const last = calls.filter((c) => c.kind === "update").at(-1)!.payload!;
    assert.equal(last["status"], "ERROR");
    assert.doesNotMatch(String(last["last_error"]), /RAW-GOOGLE-SECRET-DETAIL/);
  });

  test("a revoked grant reports NEEDS_REAUTH (status set by the refresh itself)", async () => {
    const { client, calls } = db({});
    const { impl } = routedFetch([
      [TOKEN, () => ({ status: 400, body: { error: "invalid_grant" } })],
    ]);
    const result = await testGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      impl,
    );
    assert.deepEqual(result, {
      ok: false,
      code: "NEEDS_REAUTH",
      message: googleCalendarIssueMessage("NEEDS_REAUTH"),
    });
    assert.equal(calls.filter((c) => c.kind === "update")[0]!.payload!["status"], "NEEDS_REAUTH");
  });

  test("no calendar chosen yet: tells the user to choose one, without calling Google", async () => {
    const { client } = db({ status: "NEEDS_CALENDAR_SELECTION", calendar_id: null });
    const { impl, calls } = routedFetch([]);
    const result = await testGoogleCalendarConnection(
      client,
      { organizationId: "org-1", connectionId: "conn-1" },
      impl,
    );
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });
});

// ------------------------------------------------------------------
// A. Webhook channel token compare
// ------------------------------------------------------------------

describe("webhook channel token", () => {
  function db(token: string | null) {
    return makeFakeSupabase(() => ({
      data: { id: "conn-1", channel_token: token, status: "CONNECTED" },
    }));
  }
  for (const [label, stored, given] of [
    ["mismatched", "token-abc", "token-abd"],
    ["prefix", "token-abc", "token-ab"],
    ["missing header", "token-abc", null],
    ["no stored token", null, "token-abc"],
  ] as const) {
    test(`${label} -> rejected`, async () => {
      const { client } = db(stored);
      const result = await handleWebhookNotification(client, {
        channelId: "ch-1",
        channelToken: given,
        resourceState: "exists",
      });
      assert.deepEqual(result, { outcome: "rejected", reason: "channel token mismatch" });
    });
  }

  test("the matching token passes (sync handshake ignored)", async () => {
    const { client } = db("token-abc");
    const result = await handleWebhookNotification(client, {
      channelId: "ch-1",
      channelToken: "token-abc",
      resourceState: "sync",
    });
    assert.equal(result.outcome, "ignored");
  });

  test("the compare is constant-time", () => {
    const src = readFileSync(join(here, "google-calendar-sync.server.ts"), "utf8");
    assert.match(src, /constantTimeEquals\(connection\.channel_token, headers\.channelToken\)/);
    assert.doesNotMatch(src, /channel_token !== headers\.channelToken/);
  });
});

// ------------------------------------------------------------------
// C. Event tagging + lookup
// ------------------------------------------------------------------

describe("ClickAI booking tag on Google events", () => {
  test("createEvent stores the booking id as a private extended property", async () => {
    const { impl, calls } = routedFetch([
      ["/events", (call) => ({ status: 200, body: { id: "evt-1", ...JSON.parse(call.body) } })],
    ]);
    const provider = new GoogleCalendarProvider({ accessToken: "a", fetchImpl: impl });
    const created = await provider.createEvent({
      calendarId: "cal",
      title: "t",
      startIso: "2030-10-14T13:00:00Z",
      endIso: "2030-10-14T13:30:00Z",
      timezone: "UTC",
      clickaiBookingId: "booking-1",
    });
    const sent = JSON.parse(calls[0]!.body);
    assert.deepEqual(sent.extendedProperties, { private: { clickai_booking_id: "booking-1" } });
    assert.equal(created.clickaiBookingId, "booking-1");
  });

  test("findEventByBookingId filters on the private property and ignores cancelled events", async () => {
    const { impl, calls } = routedFetch([
      [
        "/events?",
        () => ({
          status: 200,
          body: {
            items: [
              {
                id: "evt-cancelled",
                status: "cancelled",
                extendedProperties: { private: { clickai_booking_id: "booking-1" } },
              },
              {
                id: "evt-live",
                status: "confirmed",
                start: { dateTime: "2030-10-14T13:00:00Z" },
                end: { dateTime: "2030-10-14T13:30:00Z" },
                extendedProperties: { private: { clickai_booking_id: "booking-1" } },
              },
            ],
          },
        }),
      ],
    ]);
    const provider = new GoogleCalendarProvider({ accessToken: "a", fetchImpl: impl });
    const found = await provider.findEventByBookingId("cal", "booking-1");
    assert.equal(found?.id, "evt-live");
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get("privateExtendedProperty"), "clickai_booking_id=booking-1");
  });
});

// ------------------------------------------------------------------
// B. Friendly errors and card states
// ------------------------------------------------------------------

describe("customer-facing messages", () => {
  test("every known code has its own message and unknown codes fall back safely", () => {
    assert.match(googleCalendarIssueMessage("NEEDS_REAUTH"), /Reconnect/);
    assert.match(googleCalendarIssueMessage("CALENDAR_NOT_WRITABLE"), /can't add events/);
    assert.equal(
      googleCalendarIssueMessage("SOMETHING_RAW"),
      googleCalendarIssueMessage("UNKNOWN"),
    );
    assert.equal(
      googleCalendarIssueCode({ code: "CALENDAR_RATE_LIMITED" }),
      "CALENDAR_RATE_LIMITED",
    );
    assert.equal(googleCalendarIssueCode(new Error("raw")), "UNKNOWN");
  });

  test("callback reasons map to fixed text", () => {
    assert.match(googleCalendarCallbackMessage("invalid_state"), /different browser/);
    assert.match(googleCalendarCallbackMessage("denied"), /wasn't granted/);
    assert.match(googleCalendarCallbackMessage("<script>"), /couldn't finish/);
  });
});

describe("describeGoogleCalendarCardState", () => {
  const base = { status: "CONNECTED", calendar_id: "cal", last_error: "RAW provider text" };

  test("disconnected", () => {
    assert.equal(describeGoogleCalendarCardState(null).kind, "disconnected");
    assert.equal(
      describeGoogleCalendarCardState({ ...base, status: "DISCONNECTED" }).kind,
      "disconnected",
    );
  });
  test("choose calendar", () => {
    assert.equal(
      describeGoogleCalendarCardState({ ...base, status: "NEEDS_CALENDAR_SELECTION" }).kind,
      "choose_calendar",
    );
    assert.equal(
      describeGoogleCalendarCardState({ ...base, calendar_id: null }).kind,
      "choose_calendar",
    );
  });
  test("reauth required", () => {
    const s = describeGoogleCalendarCardState({ ...base, status: "NEEDS_REAUTH" });
    assert.equal(s.kind, "reauth_required");
    assert.equal(s.pill.tone, "error");
  });
  test("sync error from the connection itself or from failed bookings", () => {
    assert.equal(describeGoogleCalendarCardState({ ...base, status: "ERROR" }).kind, "sync_error");
    const failed = describeGoogleCalendarCardState(base, { syncFailedCount: 2 });
    assert.equal(failed.kind, "sync_error");
    assert.match(failed.message!, /2 upcoming bookings are saved/);
    assert.match(
      describeGoogleCalendarCardState(base, { syncFailedCount: 1 }).message!,
      /1 upcoming booking is saved/,
    );
  });
  test("connected", () => {
    const s = describeGoogleCalendarCardState(base, { syncFailedCount: 0 });
    assert.equal(s.kind, "connected");
    assert.equal(s.pill.label, "Connected");
  });
  test("a raw last_error is never displayed in any state", () => {
    for (const status of ["CONNECTED", "ERROR", "NEEDS_REAUTH", "NEEDS_CALENDAR_SELECTION"]) {
      const s = describeGoogleCalendarCardState({ ...base, status }, { syncFailedCount: 1 });
      assert.doesNotMatch(JSON.stringify(s), /RAW provider text/);
    }
  });
});
