import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  completeInstagramOAuth,
  assignInstagramBot,
  disconnectInstagramConnection,
  InstagramConnectionError,
} from "./instagram-connection.server.ts";

process.env["INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
process.env["META_APP_ID"] = "app-id";
process.env["META_APP_SECRET"] = "app-secret-must-never-leak";
process.env["META_GRAPH_API_VERSION"] = "v23.0";
process.env["INSTAGRAM_REDIRECT_URI"] = "https://clickai.in/cb";

interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: Record<string, unknown>;
}

function makeFakeSupabase(db: {
  businesses?: { data: unknown; error: unknown };
  existingConnection?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
  agentConfig?: { data: unknown; error: unknown };
}) {
  const calls: Call[] = [];

  function builder(table: string, op: string, payload?: unknown) {
    const filters: Record<string, unknown> = {};
    const self = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return self;
      },
      neq(col: string, val: unknown) {
        filters[`neq:${col}`] = val;
        return self;
      },
      select() {
        return self;
      },
      maybeSingle() {
        calls.push({ table, op, payload, filters });
        if (table === "businesses")
          return Promise.resolve(db.businesses ?? { data: null, error: null });
        if (table === "instagram_connections" && op === "select") {
          return Promise.resolve(db.existingConnection ?? { data: null, error: null });
        }
        if (table === "agent_configs")
          return Promise.resolve(db.agentConfig ?? { data: null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        calls.push({ table, op, payload, filters });
        return Promise.resolve(db.insertResult ?? { data: { id: "new-conn-id" }, error: null });
      },
      then(resolve: (r: unknown) => void, reject: (e: unknown) => void) {
        calls.push({ table, op, payload, filters });
        return Promise.resolve({ error: null }).then(resolve as never, reject);
      },
    };
    return self;
  }

  const client = {
    from(table: string) {
      return {
        select: () => builder(table, "select"),
        insert: (payload: unknown) => builder(table, "insert", payload),
        update: (payload: unknown) => builder(table, "update", payload),
      };
    },
  };

  return { client: client as never, calls };
}

function metaFetchScript(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    for (const [pathFragment, body] of Object.entries(routes)) {
      if (url.pathname.includes(pathFragment)) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ error: { message: "unscripted route" } }), {
      status: 404,
    });
  }) as typeof fetch;
}

describe("completeInstagramOAuth — happy path", () => {
  test("connects successfully when exactly one Page has a linked Instagram account", async () => {
    const { client } = makeFakeSupabase({});
    const fetchImpl = metaFetchScript({
      "/oauth/access_token": { access_token: "short-lived-tok", expires_in: 3600 },
      "/me/accounts": {
        data: [{ id: "page-1", name: "Demo Page", instagram_business_account: { id: "ig-1" } }],
      },
      "/ig-1": { id: "ig-1", username: "democafe", name: "Demo Cafe" },
      "/page-1/subscribed_apps": { success: true },
    });
    const result = await completeInstagramOAuth(
      client,
      { organizationId: "org-1", businessId: null, code: "auth-code" },
      fetchImpl,
    );
    assert.equal(result.status, "connected");
    assert.equal(result.instagramBusinessAccountId, "ig-1");
    assert.equal(result.username, "democafe");
  });
});

describe("completeInstagramOAuth — account discovery edge cases", () => {
  test("throws NO_INSTAGRAM_ACCOUNT when no Page has a linked Instagram account", async () => {
    const { client } = makeFakeSupabase({});
    const fetchImpl = metaFetchScript({
      "/oauth/access_token": { access_token: "tok", expires_in: 3600 },
      "/me/accounts": { data: [{ id: "page-1", name: "No IG here" }] },
    });
    await assert.rejects(
      () =>
        completeInstagramOAuth(
          client,
          { organizationId: "org-1", businessId: null, code: "c" },
          fetchImpl,
        ),
      (err: unknown) => {
        assert.ok(err instanceof InstagramConnectionError);
        assert.equal(err.code, "NO_INSTAGRAM_ACCOUNT");
        return true;
      },
    );
  });

  test("throws AMBIGUOUS_ACCOUNT when more than one Page has a linked Instagram account", async () => {
    const { client } = makeFakeSupabase({});
    const fetchImpl = metaFetchScript({
      "/oauth/access_token": { access_token: "tok", expires_in: 3600 },
      "/me/accounts": {
        data: [
          { id: "page-1", name: "A", instagram_business_account: { id: "ig-1" } },
          { id: "page-2", name: "B", instagram_business_account: { id: "ig-2" } },
        ],
      },
    });
    await assert.rejects(
      () =>
        completeInstagramOAuth(
          client,
          { organizationId: "org-1", businessId: null, code: "c" },
          fetchImpl,
        ),
      (err: unknown) => {
        assert.ok(err instanceof InstagramConnectionError);
        assert.equal(err.code, "AMBIGUOUS_ACCOUNT");
        return true;
      },
    );
  });
});

describe("completeInstagramOAuth — tenant isolation", () => {
  test("throws INVALID_BUSINESS when businessId does not belong to organizationId", async () => {
    const { client } = makeFakeSupabase({
      businesses: { data: { id: "biz-1", organization_id: "OTHER-ORG" }, error: null },
    });
    const fetchImpl = metaFetchScript({});
    await assert.rejects(
      () =>
        completeInstagramOAuth(
          client,
          { organizationId: "org-1", businessId: "biz-1", code: "c" },
          fetchImpl,
        ),
      (err: unknown) => {
        assert.ok(err instanceof InstagramConnectionError);
        assert.equal(err.code, "INVALID_BUSINESS");
        return true;
      },
    );
  });

  test("throws DUPLICATE_ACCOUNT when the Instagram account is already connected to a different organization", async () => {
    const { client } = makeFakeSupabase({
      existingConnection: {
        data: { id: "conn-x", organization_id: "OTHER-ORG", status: "connected" },
        error: null,
      },
    });
    const fetchImpl = metaFetchScript({
      "/oauth/access_token": { access_token: "tok", expires_in: 3600 },
      "/me/accounts": {
        data: [{ id: "page-1", name: "A", instagram_business_account: { id: "ig-1" } }],
      },
      "/ig-1": { id: "ig-1", username: "x", name: "X" },
    });
    await assert.rejects(
      () =>
        completeInstagramOAuth(
          client,
          { organizationId: "org-1", businessId: null, code: "c" },
          fetchImpl,
        ),
      (err: unknown) => {
        assert.ok(err instanceof InstagramConnectionError);
        assert.equal(err.code, "DUPLICATE_ACCOUNT");
        return true;
      },
    );
  });

  test("never leaks the app secret through any thrown error message", async () => {
    const { client } = makeFakeSupabase({});
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid OAuth code" } }), {
        status: 400,
      })) as typeof fetch;
    try {
      await completeInstagramOAuth(
        client,
        { organizationId: "org-1", businessId: null, code: "bad" },
        fetchImpl,
      );
      assert.fail("expected rejection");
    } catch (err) {
      assert.doesNotMatch((err as Error).message, /app-secret-must-never-leak/);
    }
  });
});

describe("assignInstagramBot / disconnectInstagramConnection — ownership checks", () => {
  test("assignInstagramBot rejects a connection id that does not belong to the caller's org", async () => {
    const { client } = makeFakeSupabase({});
    await assert.rejects(
      () =>
        assignInstagramBot(client, {
          organizationId: "org-1",
          connectionId: "conn-not-found",
          agentConfigId: null,
        }),
      (err: unknown) => {
        assert.ok(err instanceof InstagramConnectionError);
        assert.equal(err.code, "NOT_FOUND");
        return true;
      },
    );
  });

  test("disconnectInstagramConnection rejects a connection id that does not belong to the caller's org", async () => {
    const { client } = makeFakeSupabase({});
    await assert.rejects(
      () =>
        disconnectInstagramConnection(client, {
          organizationId: "org-1",
          connectionId: "conn-not-found",
        }),
      (err: unknown) => {
        assert.ok(err instanceof InstagramConnectionError);
        assert.equal(err.code, "NOT_FOUND");
        return true;
      },
    );
  });
});
