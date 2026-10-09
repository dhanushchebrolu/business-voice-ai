import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  reconcileExternalEvent,
  handleWebhookNotification,
  syncConnection,
  ensureWatchChannel,
} from "./google-calendar-sync.server.ts";
import { encryptCredential } from "./google-calendar-crypto.server.ts";
import type { RawGoogleSyncEvent } from "../calendar/google-calendar-provider.server.ts";

const CRYPTO_KEY = "GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY";
const CONFIG_VARS = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
  "GOOGLE_CALENDAR_WEBHOOK_URL",
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

/**
 * A faithful-enough fake Supabase client: every chain method returns the
 * same thenable object, so a statement resolves on whichever method ends
 * the chain (.maybeSingle(), a bare .eq() after .update(), .upsert(),
 * .insert()) — matching real supabase-js's own "the builder is a thenable"
 * behavior, rather than hard-coding one particular chain shape per call
 * site the way a narrower fake would.
 */
function makeFakeSupabase(script: { result: unknown }[]) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  let i = 0;

  function consume(table: string) {
    const entry = script[i];
    i++;
    if (!entry) throw new Error(`test bug: no scripted response for call #${i} on ${table}`);
    return entry.result;
  }

  function chain(table: string): Record<string, (...a: unknown[]) => unknown> {
    const self: Record<string, (...a: unknown[]) => unknown> = {};
    for (const method of ["select", "eq", "not", "update", "upsert", "insert", "maybeSingle"]) {
      self[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return self;
      };
    }
    (self as unknown as { then: unknown })["then"] = (
      resolve: (v: unknown) => void,
      reject?: (e: unknown) => void,
    ) => {
      try {
        const result = consume(table);
        calls.push({ table, method: "RESOLVED", args: [] }); // marks one genuine round-trip, distinct from the per-chain-method entries above
        resolve(result);
      } catch (e) {
        if (reject) reject(e);
        else throw e;
      }
    };
    return self;
  }

  const client = { from: (table: string) => chain(table) };
  return { client: client as never, calls };
}

function fakeFetchSequence(responses: { status: number; body: unknown }[]): {
  fetchImpl: typeof fetch;
  requests: { method: string; url: string; body: unknown }[];
} {
  let i = 0;
  const requests: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    let parsedBody: unknown;
    try {
      parsedBody = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      parsedBody = init?.body; // not JSON (e.g. the OAuth token endpoint's form-encoded body)
    }
    requests.push({ method: init?.method ?? "GET", url, body: parsedBody });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const CONNECTION = { id: "conn-1", organization_id: "org-1", business_id: "biz-1" };
const CONFIRMED_BOOKING_START = "2026-10-20T10:30:00.000Z";
const CONFIRMED_BOOKING_END = "2026-10-20T11:00:00.000Z";

function confirmedEvent(overrides: Partial<RawGoogleSyncEvent> = {}): RawGoogleSyncEvent {
  return {
    id: "gevt-1",
    status: "confirmed",
    start: { dateTime: CONFIRMED_BOOKING_START },
    end: { dateTime: CONFIRMED_BOOKING_END },
    updated: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("reconcileExternalEvent — the per-event reconciliation core", () => {
  test("1. an external event with no matching booking is cached as a plain busy period, no conflict", async () => {
    const { client, calls } = makeFakeSupabase([
      { result: { data: null, error: null } }, // bookings lookup: no match
      { result: { error: null } }, // external_calendar_events upsert
    ]);
    const didConflict = await reconcileExternalEvent(client, CONNECTION, confirmedEvent());
    assert.equal(didConflict, false);
    const upsertCall = calls.find(
      (c) => c.table === "external_calendar_events" && c.method === "upsert",
    );
    assert.ok(upsertCall, "expected an external_calendar_events upsert");
    const payload = upsertCall!.args[0] as Record<string, unknown>;
    assert.equal(payload["is_clickai_managed"], false);
    assert.equal(payload["linked_booking_id"], null);
    assert.equal(calls.filter((c) => c.table === "calendar_sync_conflicts").length, 0);
  });

  test("2. an external event update recalculates the cached start/end (same event id, new times)", async () => {
    const { client, calls } = makeFakeSupabase([
      { result: { data: null, error: null } },
      { result: { error: null } },
    ]);
    await reconcileExternalEvent(
      client,
      CONNECTION,
      confirmedEvent({
        start: { dateTime: "2026-10-21T09:00:00.000Z" },
        end: { dateTime: "2026-10-21T09:30:00.000Z" },
      }),
    );
    const upsertCall = calls.find(
      (c) => c.table === "external_calendar_events" && c.method === "upsert",
    );
    const payload = upsertCall!.args[0] as Record<string, unknown>;
    assert.equal(payload["start_at"], "2026-10-21T09:00:00.000Z");
    assert.equal(payload["end_at"], "2026-10-21T09:30:00.000Z");
  });

  test("3. a cancelled external event with no linked booking just clears its own busy effect, no conflict", async () => {
    const { client, calls } = makeFakeSupabase([
      { result: { data: null, error: null } },
      { result: { error: null } },
    ]);
    const didConflict = await reconcileExternalEvent(
      client,
      CONNECTION,
      confirmedEvent({ status: "cancelled" }),
    );
    assert.equal(didConflict, false);
    const upsertCall = calls.find(
      (c) => c.table === "external_calendar_events" && c.method === "upsert",
    );
    assert.equal((upsertCall!.args[0] as Record<string, unknown>)["status"], "cancelled");
    assert.equal(calls.filter((c) => c.table === "calendar_sync_conflicts").length, 0);
  });

  test("4. a ClickAI-managed event deleted externally records an EXTERNALLY_DELETED conflict — never touches the booking row", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            start_at: CONFIRMED_BOOKING_START,
            end_at: CONFIRMED_BOOKING_END,
            status: "CONFIRMED",
          },
          error: null,
        },
      }, // bookings lookup: matched by google_event_id
      { result: { error: null } }, // external_calendar_events upsert
      { result: { data: null, error: null } }, // no existing OPEN conflict
      { result: { error: null } }, // conflict insert
    ]);
    const didConflict = await reconcileExternalEvent(
      client,
      CONNECTION,
      confirmedEvent({ status: "cancelled" }),
    );
    assert.equal(didConflict, true);
    assert.equal(
      calls.filter(
        (c) => c.table === "bookings" && ["update", "insert", "upsert"].includes(c.method),
      ).length,
      0,
      "the bookings row itself is never written to",
    );
    const conflictInsert = calls.find(
      (c) => c.table === "calendar_sync_conflicts" && c.method === "insert",
    );
    assert.ok(conflictInsert);
    const payload = conflictInsert!.args[0] as Record<string, unknown>;
    assert.equal(payload["conflict_type"], "EXTERNALLY_DELETED");
    assert.equal(payload["booking_id"], "booking-1");
  });

  test("5. a ClickAI-managed event whose time was changed externally records an EXTERNALLY_MODIFIED conflict — booking untouched", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            start_at: CONFIRMED_BOOKING_START,
            end_at: CONFIRMED_BOOKING_END,
            status: "CONFIRMED",
          },
          error: null,
        },
      },
      { result: { error: null } },
      { result: { data: null, error: null } },
      { result: { error: null } },
    ]);
    const didConflict = await reconcileExternalEvent(
      client,
      CONNECTION,
      confirmedEvent({
        start: { dateTime: "2026-10-20T14:00:00.000Z" },
        end: { dateTime: "2026-10-20T14:30:00.000Z" },
      }),
    );
    assert.equal(didConflict, true);
    const conflictInsert = calls.find(
      (c) => c.table === "calendar_sync_conflicts" && c.method === "insert",
    );
    const payload = conflictInsert!.args[0] as Record<string, unknown>;
    assert.equal(payload["conflict_type"], "EXTERNALLY_MODIFIED");
    const details = payload["details"] as Record<string, unknown>;
    assert.equal(details["bookingStartAt"], CONFIRMED_BOOKING_START);
    assert.equal(details["externalStartAt"], "2026-10-20T14:00:00.000Z");
  });

  test("6. a ClickAI-managed event whose time is UNCHANGED produces no conflict at all", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            start_at: CONFIRMED_BOOKING_START,
            end_at: CONFIRMED_BOOKING_END,
            status: "CONFIRMED",
          },
          error: null,
        },
      },
      { result: { error: null } },
    ]);
    const didConflict = await reconcileExternalEvent(client, CONNECTION, confirmedEvent());
    assert.equal(didConflict, false);
    assert.equal(calls.filter((c) => c.table === "calendar_sync_conflicts").length, 0);
  });

  test("7. idempotent: a repeated notification for the same already-recorded conflict never inserts a second OPEN row", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            start_at: CONFIRMED_BOOKING_START,
            end_at: CONFIRMED_BOOKING_END,
            status: "CONFIRMED",
          },
          error: null,
        },
      },
      { result: { error: null } },
      { result: { data: { id: "existing-conflict-1" }, error: null } }, // an OPEN conflict already exists
    ]);
    const didConflict = await reconcileExternalEvent(
      client,
      CONNECTION,
      confirmedEvent({ status: "cancelled" }),
    );
    assert.equal(didConflict, true, "still reported as a live conflict");
    assert.equal(
      calls.filter((c) => c.table === "calendar_sync_conflicts" && c.method === "insert").length,
      0,
      "must not insert a duplicate OPEN conflict row",
    );
  });

  test("8. an all-day event (date-only, no dateTime) is cached with is_all_day true", async () => {
    const { client, calls } = makeFakeSupabase([
      { result: { data: null, error: null } },
      { result: { error: null } },
    ]);
    await reconcileExternalEvent(
      client,
      CONNECTION,
      confirmedEvent({ start: { date: "2026-10-25" }, end: { date: "2026-10-26" } }),
    );
    const upsertCall = calls.find(
      (c) => c.table === "external_calendar_events" && c.method === "upsert",
    );
    assert.equal((upsertCall!.args[0] as Record<string, unknown>)["is_all_day"], true);
  });
});

describe("handleWebhookNotification — tenant-safe channel authentication", () => {
  test("9. a notification for an unknown channel id is rejected before any sync work", async () => {
    const { client, calls } = makeFakeSupabase([{ result: { data: null, error: null } }]);
    const result = await handleWebhookNotification(client, {
      channelId: "unknown-channel",
      channelToken: "whatever",
      resourceState: "exists",
    });
    assert.equal(result.outcome, "rejected");
    assert.equal(calls.filter((c) => c.method === "RESOLVED").length, 1);
  });

  test("10. a channel token mismatch is rejected, even for a real, known channel id", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: { id: "conn-1", channel_token: "real-secret", status: "CONNECTED" },
          error: null,
        },
      },
    ]);
    const result = await handleWebhookNotification(client, {
      channelId: "known-channel",
      channelToken: "guessed-wrong-secret",
      resourceState: "exists",
    });
    assert.equal(result.outcome, "rejected");
    assert.equal(result.reason, "channel token mismatch");
  });

  test("a 'sync' handshake notification (channel registration confirmation, not a real change) is ignored, not synced", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: { id: "conn-1", channel_token: "real-secret", status: "CONNECTED" },
          error: null,
        },
      },
    ]);
    const result = await handleWebhookNotification(client, {
      channelId: "known-channel",
      channelToken: "real-secret",
      resourceState: "sync",
    });
    assert.equal(result.outcome, "ignored");
    assert.equal(
      calls.filter((c) => c.method === "RESOLVED").length,
      1,
      "no further round-trips — syncConnection must never be invoked for a handshake",
    );
  });

  test("a notification for a disconnected connection is ignored, never synced", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: { id: "conn-1", channel_token: "real-secret", status: "DISCONNECTED" },
          error: null,
        },
      },
    ]);
    const result = await handleWebhookNotification(client, {
      channelId: "known-channel",
      channelToken: "real-secret",
      resourceState: "exists",
    });
    assert.equal(result.outcome, "ignored");
  });
});

describe("syncConnection — incremental sync, pagination, and loop prevention", () => {
  test("11. processes a single page, persists the returned nextSyncToken, and never calls a Google write endpoint (loop prevention)", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh-token" }));
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "conn-1",
            organization_id: "org-1",
            business_id: "biz-1",
            calendar_id: "clinic-cal",
            sync_token: "old-token",
          },
          error: null,
        },
      }, // syncConnection's own connection read
      {
        result: {
          data: {
            id: "conn-1",
            status: "CONNECTED",
            calendar_id: "clinic-cal",
            encrypted_credentials: encrypted,
          },
          error: null,
        },
      }, // getValidGoogleAccessToken's connection read
      { result: { error: null } }, // getValidGoogleAccessToken's token-refresh bookkeeping update
      { result: { data: null, error: null } }, // reconcileExternalEvent: bookings lookup
      { result: { error: null } }, // reconcileExternalEvent: external_calendar_events upsert
      { result: { error: null } }, // syncConnection's own sync_token persistence
    ]);
    const { fetchImpl, requests } = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } }, // OAuth refresh
      {
        status: 200,
        body: { items: [confirmedEvent()], nextSyncToken: "new-token-123" },
      }, // events.list
    ]);

    const result = await syncConnection(client, "conn-1", fetchImpl);
    assert.equal(result.processedEvents, 1);
    assert.equal(result.fullResync, false);

    const persistCall = calls.find(
      (c) =>
        c.table === "google_calendar_connections" &&
        c.method === "update" &&
        (c.args[0] as Record<string, unknown>)["sync_token"] === "new-token-123",
    );
    assert.ok(persistCall, "expected the new sync token to be persisted");

    for (const req of requests) {
      assert.notEqual(req.method, "PATCH", "sync must never PATCH (update) a Google event");
      assert.notEqual(req.method, "DELETE", "sync must never DELETE a Google event");
      if (req.method === "POST") {
        assert.ok(
          req.url.includes("/events/watch") ||
            req.url.includes("oauth2") ||
            req.url.includes("token"),
          `sync must never POST to create an event — unexpected POST to ${req.url}`,
        );
      }
    }
  });

  test("12. a 410 (expired sync token) triggers exactly one fresh full-resync bootstrap, not an infinite loop", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh-token" }));
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "conn-1",
            organization_id: "org-1",
            business_id: "biz-1",
            calendar_id: "clinic-cal",
            sync_token: "expired-token",
          },
          error: null,
        },
      },
      {
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
      { result: { error: null } },
      { result: { data: null, error: null } }, // bookings lookup for the one event in the bootstrap page
      { result: { error: null } }, // external_calendar_events upsert
      { result: { error: null } }, // sync_token persistence
    ]);
    const { fetchImpl, requests } = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } }, // OAuth refresh
      { status: 410, body: { error: { message: "Sync token is no longer valid" } } }, // expired
      { status: 200, body: { items: [confirmedEvent()], nextSyncToken: "bootstrap-token-456" } }, // fresh bootstrap page
    ]);

    const result = await syncConnection(client, "conn-1", fetchImpl);
    assert.equal(result.fullResync, true);
    assert.equal(result.processedEvents, 1);

    const listCalls = requests.filter((r) => r.url.includes("/events?"));
    assert.equal(listCalls.length, 2, "exactly one retry after the 410, not an unbounded loop");
    assert.ok(
      !listCalls[1]!.url.includes("syncToken="),
      "the retry must bootstrap fresh, not resend the expired token",
    );
  });

  test("13. pagination: multiple pages are all processed, and only the FINAL page's nextSyncToken is persisted", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh-token" }));
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "conn-1",
            organization_id: "org-1",
            business_id: "biz-1",
            calendar_id: "clinic-cal",
            sync_token: "old-token",
          },
          error: null,
        },
      },
      {
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
      { result: { error: null } },
      { result: { data: null, error: null } }, // page 1 event's bookings lookup
      { result: { error: null } }, // page 1 event's upsert
      { result: { data: null, error: null } }, // page 2 event's bookings lookup
      { result: { error: null } }, // page 2 event's upsert
      { result: { error: null } }, // final sync_token persistence
    ]);
    const { fetchImpl } = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } },
      {
        status: 200,
        body: { items: [confirmedEvent({ id: "gevt-page1" })], nextPageToken: "page-2" },
      },
      {
        status: 200,
        body: { items: [confirmedEvent({ id: "gevt-page2" })], nextSyncToken: "final-token-789" },
      },
    ]);

    const result = await syncConnection(client, "conn-1", fetchImpl);
    assert.equal(result.processedEvents, 2);

    const syncTokenPersistCalls = calls.filter(
      (c) =>
        c.table === "google_calendar_connections" &&
        c.method === "update" &&
        "sync_token" in (c.args[0] as Record<string, unknown>),
    );
    assert.equal(
      syncTokenPersistCalls.length,
      1,
      "sync_token is persisted exactly once, after all pages",
    );
    assert.equal(
      (syncTokenPersistCalls[0]!.args[0] as Record<string, unknown>)["sync_token"],
      "final-token-789",
    );
  });
});

describe("ensureWatchChannel — channel renewal", () => {
  test("14. a channel with plenty of runway left is left alone (no Google API call at all)", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "conn-1",
            calendar_id: "clinic-cal",
            status: "CONNECTED",
            channel_id: "existing-channel",
            channel_resource_id: "existing-resource",
            channel_expiration: new Date(Date.now() + 6 * 86_400_000).toISOString(),
          },
          error: null,
        },
      },
    ]);
    const { fetchImpl, requests } = fakeFetchSequence([{ status: 200, body: {} }]);
    const result = await ensureWatchChannel(client, "conn-1", fetchImpl);
    assert.equal(result.renewed, false);
    assert.equal(
      requests.length,
      0,
      "must not call Google at all when the channel still has runway",
    );
  });

  test("15. a channel nearing expiry is renewed, registering a fresh channel id/token and stopping the old one", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh-token" }));
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "conn-1",
            calendar_id: "clinic-cal",
            status: "CONNECTED",
            channel_id: "old-channel",
            channel_resource_id: "old-resource",
            channel_expiration: new Date(Date.now() + 1000).toISOString(), // already basically expired
          },
          error: null,
        },
      },
      {
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
      { result: { error: null } }, // token refresh bookkeeping
      { result: { error: null } }, // new channel persistence
    ]);
    const { fetchImpl, requests } = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } },
      {
        status: 200,
        body: { resourceId: "new-resource", expiration: String(Date.now() + 7 * 86_400_000) },
      }, // watch
      { status: 204, body: null }, // stop old channel
    ]);

    const result = await ensureWatchChannel(client, "conn-1", fetchImpl);
    assert.equal(result.renewed, true);

    const persistCall = calls.find(
      (c) =>
        c.table === "google_calendar_connections" &&
        c.method === "update" &&
        "channel_id" in (c.args[0] as Record<string, unknown>),
    );
    assert.ok(persistCall, "expected a channel_id persistence update");
    const payload = persistCall!.args[0] as Record<string, unknown>;
    assert.ok(payload["channel_id"], "a new channel id is generated and persisted");
    assert.notEqual(payload["channel_id"], "old-channel");

    const watchRequest = requests.find((r) => r.url.includes("/events/watch"));
    assert.ok(watchRequest, "must register a new watch channel with Google");
    const stopRequest = requests.find((r) => r.url.includes("/channels/stop"));
    assert.ok(stopRequest, "must stop the superseded channel");
  });
});
