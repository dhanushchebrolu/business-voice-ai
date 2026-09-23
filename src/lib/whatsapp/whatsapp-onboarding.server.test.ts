import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  completeWhatsAppOnboarding,
  WhatsAppOnboardingError,
  type WhatsAppOnboardingDeps,
} from "./whatsapp-onboarding.server.ts";
import { MetaApiError } from "./meta-client.server.ts";

/**
 * Behavioral coverage for the onboarding orchestration core, exercised
 * against a scripted fake Supabase client (same spirit as
 * sarvam-inbound-deployment.server.test.ts — no live Supabase instance in
 * this environment) and a fake MetaWhatsAppClient (no real network call,
 * per Phase 2's explicit testing requirement).
 */

interface Call {
  table: string;
  op: "select" | "insert" | "update";
  payload?: unknown;
  filters: Record<string, unknown>;
}

interface FakeDb {
  businesses?: { data: unknown; error: unknown } | undefined;
  whatsappConnectionsSelect?: { data: unknown; error: unknown } | undefined;
  whatsappConnectionsInsert?: { data: unknown; error: unknown } | undefined;
  whatsappConnectionsUpdate?: { error: unknown } | undefined;
}

function makeFakeSupabase(db: FakeDb) {
  const calls: Call[] = [];

  function builder(table: string, op: Call["op"], payload?: unknown) {
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
        if (table === "whatsapp_connections" && op === "select")
          return Promise.resolve(db.whatsappConnectionsSelect ?? { data: null, error: null });
        throw new Error(`test bug: unscripted maybeSingle for ${table}/${op}`);
      },
      single() {
        calls.push({ table, op, payload, filters });
        return Promise.resolve(
          db.whatsappConnectionsInsert ?? { data: { id: "new-connection-id" }, error: null },
        );
      },
      then(resolve: (r: unknown) => void, reject: (e: unknown) => void) {
        calls.push({ table, op, payload, filters });
        return Promise.resolve(db.whatsappConnectionsUpdate ?? { error: null }).then(
          resolve as never,
          reject,
        );
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

function fakeMetaClient(overrides: Partial<WhatsAppOnboardingDeps["metaClient"]> = {}) {
  return {
    exchangeAuthorizationCode: async () => ({
      accessToken: "raw-access-token-must-never-leak",
      tokenType: "bearer",
      expiresIn: null,
    }),
    getPhoneNumber: async (phoneNumberId: string) => ({
      id: phoneNumberId,
      displayPhoneNumber: "+91 98765 43210",
      verifiedName: "ClickAI Demo Business",
      qualityRating: "GREEN",
    }),
    registerPhoneNumber: async () => ({ success: true }),
    subscribeApp: async () => ({ success: true }),
    ...overrides,
  };
}

const baseInput = {
  organizationId: "org-1",
  businessId: null,
  code: "auth-code-xyz",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
};

const baseDeps = (overrides: Partial<WhatsAppOnboardingDeps> = {}): WhatsAppOnboardingDeps => ({
  metaClient: fakeMetaClient(),
  encryptCredential: (plaintext: string) => `ENCRYPTED(${plaintext})`,
  generatePin: () => "042871",
  ...overrides,
});

describe("onboarding success path", () => {
  test("connects end-to-end: status 'connected', identifiers and webhookSubscribed correct", async () => {
    const { client } = makeFakeSupabase({});
    const result = await completeWhatsAppOnboarding(client, baseInput, baseDeps());
    assert.equal(result.status, "connected");
    assert.equal(result.connectionId, "new-connection-id");
    assert.equal(result.wabaId, "waba-1");
    assert.equal(result.phoneNumberId, "phone-1");
    assert.equal(result.displayPhoneNumber, "+91 98765 43210");
    assert.equal(result.verifiedName, "ClickAI Demo Business");
    assert.equal(result.webhookSubscribed, true);
    assert.equal(result.lastError, null);
  });

  test("the returned result never contains the raw access token or PIN", async () => {
    const { client } = makeFakeSupabase({});
    const result = await completeWhatsAppOnboarding(client, baseInput, baseDeps());
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /raw-access-token-must-never-leak/);
    assert.doesNotMatch(serialized, /042871/);
  });

  test("the persisted row is encrypted via the injected encryptCredential, never plaintext", async () => {
    const { client, calls } = makeFakeSupabase({});
    await completeWhatsAppOnboarding(client, baseInput, baseDeps());
    const finalUpdate = calls
      .filter((c) => c.table === "whatsapp_connections" && c.op === "update")
      .pop();
    const payload = finalUpdate!.payload as Record<string, unknown>;
    assert.equal(payload["access_token_ciphertext"], "ENCRYPTED(raw-access-token-must-never-leak)");
    assert.equal(payload["two_step_pin_ciphertext"], "ENCRYPTED(042871)");
  });

  test("a valid businessId belonging to the same organization is accepted and stored", async () => {
    const { client, calls } = makeFakeSupabase({
      businesses: { data: { id: "biz-1", organization_id: "org-1" }, error: null },
    });
    await completeWhatsAppOnboarding(client, { ...baseInput, businessId: "biz-1" }, baseDeps());
    const insertCall = calls.find((c) => c.table === "whatsapp_connections" && c.op === "insert");
    assert.equal((insertCall!.payload as Record<string, unknown>)["business_id"], "biz-1");
  });
});

describe("registration failure (rollback behavior)", () => {
  test("returns status 'error' with a safe lastError instead of throwing, and never leaves the row without a diagnosable state", async () => {
    const { client, calls } = makeFakeSupabase({});
    const deps = baseDeps({
      metaClient: fakeMetaClient({
        registerPhoneNumber: async () => {
          throw new MetaApiError("Meta rejected the request as invalid. Invalid PIN format.", 400);
        },
      }),
    });
    const result = await completeWhatsAppOnboarding(client, baseInput, deps);
    assert.equal(result.status, "error");
    assert.equal(result.webhookSubscribed, false);
    assert.match(result.lastError ?? "", /Invalid PIN format/);

    const errorUpdate = calls
      .filter((c) => c.table === "whatsapp_connections" && c.op === "update")
      .pop();
    assert.equal((errorUpdate!.payload as Record<string, unknown>)["status"], "error");
  });

  test("no ciphertext is written when registration fails", async () => {
    const { client, calls } = makeFakeSupabase({});
    const deps = baseDeps({
      metaClient: fakeMetaClient({
        registerPhoneNumber: async () => {
          throw new MetaApiError("registration failed", 400);
        },
      }),
    });
    await completeWhatsAppOnboarding(client, baseInput, deps);
    const errorUpdate = calls
      .filter((c) => c.table === "whatsapp_connections" && c.op === "update")
      .pop();
    const payload = errorUpdate!.payload as Record<string, unknown>;
    assert.equal("access_token_ciphertext" in payload, false);
  });
});

describe("webhook subscription failure (partial success)", () => {
  test("status is 'needs_attention', but the token/PIN ARE still persisted (registration succeeded)", async () => {
    const { client, calls } = makeFakeSupabase({});
    const deps = baseDeps({
      metaClient: fakeMetaClient({
        subscribeApp: async () => {
          throw new MetaApiError("Meta is temporarily unavailable. Please retry.", 503);
        },
      }),
    });
    const result = await completeWhatsAppOnboarding(client, baseInput, deps);
    assert.equal(result.status, "needs_attention");
    assert.equal(result.webhookSubscribed, false);

    const finalUpdate = calls
      .filter((c) => c.table === "whatsapp_connections" && c.op === "update")
      .pop();
    const payload = finalUpdate!.payload as Record<string, unknown>;
    assert.ok(
      payload["access_token_ciphertext"],
      "token must still be persisted for a later retry",
    );
    assert.equal(payload["webhook_subscribed"], false);
  });
});

describe("code exchange / phone lookup failure (no row created yet)", () => {
  test("a code exchange failure throws WhatsAppOnboardingError with code 'exchange_failed', no DB write", async () => {
    const { client, calls } = makeFakeSupabase({});
    const deps = baseDeps({
      metaClient: fakeMetaClient({
        exchangeAuthorizationCode: async () => {
          throw new MetaApiError("Meta rejected the request as invalid.", 400);
        },
      }),
    });
    await assert.rejects(
      () => completeWhatsAppOnboarding(client, baseInput, deps),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppOnboardingError);
        assert.equal(err.code, "exchange_failed");
        return true;
      },
    );
    assert.equal(calls.filter((c) => c.table === "whatsapp_connections").length, 0);
  });

  test("a phone-number lookup failure (token doesn't cover the claimed id) throws 'phone_lookup_failed', no DB write", async () => {
    const { client, calls } = makeFakeSupabase({});
    const deps = baseDeps({
      metaClient: fakeMetaClient({
        getPhoneNumber: async () => {
          throw new MetaApiError("Meta denied access to this WhatsApp asset.", 403);
        },
      }),
    });
    await assert.rejects(
      () => completeWhatsAppOnboarding(client, baseInput, deps),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppOnboardingError);
        assert.equal(err.code, "phone_lookup_failed");
        return true;
      },
    );
    assert.equal(calls.filter((c) => c.table === "whatsapp_connections").length, 0);
  });
});

describe("tenant isolation", () => {
  test("a businessId belonging to a DIFFERENT organization is rejected before any Meta call", async () => {
    const { client } = makeFakeSupabase({
      businesses: { data: { id: "biz-1", organization_id: "some-other-org" }, error: null },
    });
    let metaCalled = false;
    const deps = baseDeps({
      metaClient: fakeMetaClient({
        exchangeAuthorizationCode: async () => {
          metaCalled = true;
          return { accessToken: "x", tokenType: null, expiresIn: null };
        },
      }),
    });
    await assert.rejects(
      () => completeWhatsAppOnboarding(client, { ...baseInput, businessId: "biz-1" }, deps),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppOnboardingError);
        assert.equal(err.code, "invalid_business");
        return true;
      },
    );
    assert.equal(metaCalled, false, "must reject before ever contacting Meta");
  });

  test("a businessId that does not exist at all is rejected", async () => {
    const { client } = makeFakeSupabase({ businesses: { data: null, error: null } });
    await assert.rejects(
      () =>
        completeWhatsAppOnboarding(client, { ...baseInput, businessId: "nonexistent" }, baseDeps()),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppOnboardingError);
        assert.equal(err.code, "invalid_business");
        return true;
      },
    );
  });
});

describe("duplicate connection handling", () => {
  test("a phone_number_id already connected to a DIFFERENT organization is rejected", async () => {
    const { client, calls } = makeFakeSupabase({
      whatsappConnectionsSelect: {
        data: { id: "existing-row", organization_id: "some-other-org", status: "connected" },
        error: null,
      },
    });
    await assert.rejects(
      () => completeWhatsAppOnboarding(client, baseInput, baseDeps()),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppOnboardingError);
        assert.equal(err.code, "duplicate_phone_number");
        return true;
      },
    );
    assert.equal(
      calls.some((c) => c.op === "insert" || c.op === "update"),
      false,
    );
  });

  test("re-onboarding the SAME organization's existing connection updates that row instead of inserting a duplicate", async () => {
    const { client, calls } = makeFakeSupabase({
      whatsappConnectionsSelect: {
        data: { id: "existing-row-same-org", organization_id: "org-1", status: "error" },
        error: null,
      },
    });
    const result = await completeWhatsAppOnboarding(client, baseInput, baseDeps());
    assert.equal(result.connectionId, "existing-row-same-org");
    assert.equal(
      calls.some((c) => c.table === "whatsapp_connections" && c.op === "insert"),
      false,
      "must not insert a second row for the same org+number",
    );
  });

  test("a concurrent-race 23505 on insert is handled as a safe duplicate error, not a raw DB error", async () => {
    const { client } = makeFakeSupabase({
      whatsappConnectionsInsert: { data: null, error: { code: "23505" } },
    });
    await assert.rejects(
      () => completeWhatsAppOnboarding(client, baseInput, baseDeps()),
      (err: unknown) => {
        assert.ok(err instanceof WhatsAppOnboardingError);
        assert.equal(err.code, "duplicate_phone_number");
        return true;
      },
    );
  });
});

describe("secret leakage prevention", () => {
  test("no thrown error ever contains the raw access token", async () => {
    const { client } = makeFakeSupabase({});
    const deps = baseDeps({
      metaClient: fakeMetaClient({
        registerPhoneNumber: async () => {
          throw new MetaApiError("failed", 400);
        },
      }),
    });
    // registration failure returns (doesn't throw) — assert the returned
    // lastError specifically excludes the token even though the token was
    // already exchanged successfully by this point in the sequence.
    const result = await completeWhatsAppOnboarding(client, baseInput, deps);
    assert.doesNotMatch(result.lastError ?? "", /raw-access-token-must-never-leak/);
  });
});
