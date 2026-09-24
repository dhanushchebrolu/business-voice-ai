import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createOAuthState, consumeOAuthState, OAuthStateError } from "./oauth-state.server.ts";

/**
 * Behavioral coverage against a scripted fake Supabase client (same spirit
 * as whatsapp-onboarding.server.test.ts — no live Supabase instance in
 * this environment).
 */

interface InsertCall {
  table: string;
  payload: Record<string, unknown>;
}

interface UpdateCall {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeFakeSupabase(opts: {
  insertResult?: { error: unknown };
  updateResult?: { data: unknown; error: unknown };
}) {
  const insertCalls: InsertCall[] = [];
  const updateCalls: UpdateCall[] = [];

  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          insertCalls.push({ table, payload });
          return Promise.resolve(opts.insertResult ?? { error: null });
        },
        update(payload: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          const self = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return self;
            },
            is(col: string, val: unknown) {
              filters[`is:${col}`] = val;
              return self;
            },
            gt(col: string, val: unknown) {
              filters[`gt:${col}`] = val;
              return self;
            },
            select() {
              return self;
            },
            maybeSingle() {
              updateCalls.push({ table, payload, filters });
              return Promise.resolve(opts.updateResult ?? { data: null, error: null });
            },
          };
          return self;
        },
      };
    },
  };

  return { client: client as never, insertCalls, updateCalls };
}

describe("createOAuthState", () => {
  test("stores a fresh state tied to the caller's org/business/user, and returns it", async () => {
    const { client, insertCalls } = makeFakeSupabase({});
    const state = await createOAuthState(client, {
      provider: "google_calendar",
      organizationId: "org-1",
      businessId: "biz-1",
      userId: "user-1",
      redirectTo: "/app/integrations",
    });

    assert.equal(typeof state, "string");
    assert.ok(state.length > 20, "expected a long, unpredictable token");
    assert.equal(insertCalls.length, 1);
    assert.equal(insertCalls[0]!.payload["organization_id"], "org-1");
    assert.equal(insertCalls[0]!.payload["business_id"], "biz-1");
    assert.equal(insertCalls[0]!.payload["user_id"], "user-1");
    assert.equal(insertCalls[0]!.payload["provider"], "google_calendar");
    assert.equal(insertCalls[0]!.payload["state"], state);
  });

  test("two calls never produce the same state (unpredictable, not sequential)", async () => {
    const { client } = makeFakeSupabase({});
    const a = await createOAuthState(client, {
      provider: "google_calendar",
      organizationId: "org-1",
      businessId: null,
      userId: "user-1",
    });
    const b = await createOAuthState(client, {
      provider: "google_calendar",
      organizationId: "org-1",
      businessId: null,
      userId: "user-1",
    });
    assert.notEqual(a, b);
  });

  test("propagates a database error as OAuthStateError", async () => {
    const { client } = makeFakeSupabase({ insertResult: { error: { message: "db down" } } });
    await assert.rejects(
      () =>
        createOAuthState(client, {
          provider: "google_calendar",
          organizationId: "org-1",
          businessId: null,
          userId: "user-1",
        }),
      OAuthStateError,
    );
  });
});

describe("consumeOAuthState", () => {
  test("returns the stored tenant context for a valid, unexpired, unconsumed state", async () => {
    const { client, updateCalls } = makeFakeSupabase({
      updateResult: {
        data: {
          organization_id: "org-1",
          business_id: "biz-1",
          user_id: "user-1",
          redirect_to: "/app/integrations",
        },
        error: null,
      },
    });

    const result = await consumeOAuthState(client, "google_calendar", "real-state-token");
    assert.deepEqual(result, {
      organizationId: "org-1",
      businessId: "biz-1",
      userId: "user-1",
      redirectTo: "/app/integrations",
    });

    // Consuming is a single atomic UPDATE ... WHERE consumed_at IS NULL AND
    // expires_at > now(), not a read-then-write.
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0]!.filters["state"], "real-state-token");
    assert.equal(updateCalls[0]!.filters["provider"], "google_calendar");
    assert.equal(updateCalls[0]!.filters["is:consumed_at"], null);
    assert.ok("gt:expires_at" in updateCalls[0]!.filters);
  });

  test("rejects a missing/empty state before touching the database", async () => {
    const { client, updateCalls } = makeFakeSupabase({});
    await assert.rejects(() => consumeOAuthState(client, "google_calendar", ""), OAuthStateError);
    assert.equal(updateCalls.length, 0);
  });

  test("rejects an unknown, expired, or already-consumed state (no matching row)", async () => {
    const { client } = makeFakeSupabase({ updateResult: { data: null, error: null } });
    await assert.rejects(
      () => consumeOAuthState(client, "google_calendar", "stale-or-fake-token"),
      OAuthStateError,
    );
  });

  test("propagates a database error as OAuthStateError", async () => {
    const { client } = makeFakeSupabase({
      updateResult: { data: null, error: { message: "db down" } },
    });
    await assert.rejects(
      () => consumeOAuthState(client, "google_calendar", "some-token"),
      OAuthStateError,
    );
  });

  test("scopes consumption to the expected provider — a state minted for a different provider cannot be reused here", async () => {
    const { client, updateCalls } = makeFakeSupabase({
      updateResult: { data: null, error: null },
    });
    await assert.rejects(() => consumeOAuthState(client, "google_calendar", "some-token"));
    assert.equal(updateCalls[0]!.filters["provider"], "google_calendar");
  });
});
