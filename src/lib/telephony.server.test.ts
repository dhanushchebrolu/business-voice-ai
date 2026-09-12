import { test } from "node:test";
import assert from "node:assert/strict";
import { TELEPHONY_PROVIDERS, providerStatus, getTelephonyAdapter } from "./telephony.server.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";

/**
 * Config-validation coverage for the Sarvam migration's requirement A: reuse
 * SARVAM_API_KEY, do not keep SARVAM_TELEPHONY_ACCOUNT merely because older
 * code contained it. Verified from Sarvam's official documentation (see
 * sarvam-provider.server.ts's module doc) that the api-subscription-key
 * mechanism sarvam.server.ts already uses for chat/STT/TTS covers this
 * surface too — no second credential is required or introduced here.
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const SARVAM_KEY_ENV_VARS = [
  "SARVAM_API_KEY",
  "SARVAM_VOICE_AGENTS_API_KEY",
  "SARVAM_INBOUND_VOICE_API_KEY",
  "SARVAM_OUTBOUND_VOICE_API_KEY",
];

test("TELEPHONY_PROVIDERS: the sarvam entry lists the separate inbound/outbound key names", () => {
  const def = TELEPHONY_PROVIDERS.find((p) => p.id === "sarvam");
  assert.ok(def, "expected a sarvam entry in the provider registry");
  assert.deepEqual(def.requiredSecrets, [
    "SARVAM_INBOUND_VOICE_API_KEY",
    "SARVAM_OUTBOUND_VOICE_API_KEY",
  ]);
  assert.equal(def.supportsPurchase, true);
});

test("TELEPHONY_PROVIDERS: SARVAM_TELEPHONY_ACCOUNT is not required anywhere in the registry", () => {
  for (const def of TELEPHONY_PROVIDERS) {
    assert.equal(
      def.requiredSecrets.includes("SARVAM_TELEPHONY_ACCOUNT"),
      false,
      `${def.id} must not require SARVAM_TELEPHONY_ACCOUNT`,
    );
  }
});

function clearAllSarvamKeys(overrides: Record<string, string | undefined> = {}) {
  const cleared: Record<string, string | undefined> = {};
  for (const key of SARVAM_KEY_ENV_VARS) cleared[key] = undefined;
  return { ...cleared, ...overrides };
}

test("providerStatus: sarvam reports not configured when neither inbound nor outbound key resolves", () => {
  withEnv(clearAllSarvamKeys(), () => {
    const status = providerStatus().find((p) => p.id === "sarvam");
    assert.equal(status?.configured, false);
    assert.equal(status?.missing.length, 2);
  });
});

test("providerStatus: legacy SARVAM_API_KEY alone still configures both directions (backward compatibility)", () => {
  withEnv(clearAllSarvamKeys({ SARVAM_API_KEY: "sk_live_legacy" }), () => {
    const status = providerStatus().find((p) => p.id === "sarvam");
    assert.equal(status?.configured, true);
    assert.deepEqual(status?.missing, []);
  });
});

test("providerStatus: SARVAM_VOICE_AGENTS_API_KEY alone configures both directions", () => {
  withEnv(clearAllSarvamKeys({ SARVAM_VOICE_AGENTS_API_KEY: "sk_live_single" }), () => {
    const status = providerStatus().find((p) => p.id === "sarvam");
    assert.equal(status?.configured, true);
  });
});

test("providerStatus: only the outbound key set still reports configured:false — inbound remains missing", () => {
  withEnv(clearAllSarvamKeys({ SARVAM_OUTBOUND_VOICE_API_KEY: "sk_live_out" }), () => {
    const status = providerStatus().find((p) => p.id === "sarvam");
    assert.equal(status?.configured, false);
    assert.equal(
      status?.missing.some((m) => m.startsWith("SARVAM_INBOUND_VOICE_API_KEY")),
      true,
    );
  });
});

test("providerStatus: dedicated SARVAM_INBOUND_VOICE_API_KEY/SARVAM_OUTBOUND_VOICE_API_KEY together configure sarvam", () => {
  withEnv(
    clearAllSarvamKeys({
      SARVAM_INBOUND_VOICE_API_KEY: "sk_live_in",
      SARVAM_OUTBOUND_VOICE_API_KEY: "sk_live_out",
    }),
    () => {
      const status = providerStatus().find((p) => p.id === "sarvam");
      assert.equal(status?.configured, true);
      assert.deepEqual(status?.missing, []);
    },
  );
});

test("getTelephonyAdapter('sarvam'): returns null when no Sarvam key resolves at all, never a half-configured adapter", () => {
  withEnv(clearAllSarvamKeys(), () => {
    assert.equal(getTelephonyAdapter("sarvam"), null);
  });
});

test("getTelephonyAdapter('sarvam'): returns a real SarvamTelephonyAdapter once a key resolves", () => {
  withEnv(clearAllSarvamKeys({ SARVAM_API_KEY: "sk_live_example" }), () => {
    const adapter = getTelephonyAdapter("sarvam");
    assert.ok(adapter instanceof SarvamTelephonyAdapter);
    assert.equal(adapter?.id, "sarvam");
  });
});

test("getTelephonyAdapter('sarvam'): setting SARVAM_TELEPHONY_ACCOUNT alone (without SARVAM_API_KEY) is not sufficient", () => {
  withEnv(
    { SARVAM_API_KEY: undefined, SARVAM_TELEPHONY_ACCOUNT: "leftover-from-old-config" },
    () => {
      assert.equal(getTelephonyAdapter("sarvam"), null);
    },
  );
});

test("getTelephonyAdapter('sarvam'): does not fall through to the generic REST/HMAC adapter even if SARVAM_BASE_URL/SARVAM_WEBHOOK_SECRET happen to be set", () => {
  withEnv(
    {
      SARVAM_API_KEY: "sk_live_example",
      SARVAM_BASE_URL: "https://example.invalid",
      SARVAM_WEBHOOK_SECRET: "some-secret",
    },
    () => {
      const adapter = getTelephonyAdapter("sarvam");
      assert.ok(adapter instanceof SarvamTelephonyAdapter);
    },
  );
});

test("getTelephonyAdapter('sarvam'): SARVAM_BASE_URL is read by nothing — Sarvam's endpoints are hardcoded, not configurable", () => {
  // Distinguishes SARVAM_BASE_URL (still unused) from SARVAM_WEBHOOK_SECRET
  // (Phase 5 — now actually wired, see the next test): setting only
  // SARVAM_BASE_URL must not change createInboundDeployment's target host.
  let adapter!: SarvamTelephonyAdapter;
  withEnv({ SARVAM_API_KEY: "sk_live_example", SARVAM_BASE_URL: "https://example.invalid" }, () => {
    adapter = getTelephonyAdapter("sarvam") as SarvamTelephonyAdapter;
  });
  assert.ok(adapter instanceof SarvamTelephonyAdapter);
  assert.equal(
    adapter.verifyWebhookSignature(
      "",
      {},
      new URL("https://vaani.app/api/public/webhooks/telephony?provider=sarvam&verify_token=x"),
    ),
    false,
    "no webhook secret was configured, so the request must still be rejected",
  );
});

test("getTelephonyAdapter('sarvam'): SARVAM_WEBHOOK_SECRET (Phase 5), when set, actually reaches the adapter's verify_token check", () => {
  let adapter!: SarvamTelephonyAdapter;
  withEnv(
    { SARVAM_API_KEY: "sk_live_example", SARVAM_WEBHOOK_SECRET: "sarvam-shared-secret" },
    () => {
      adapter = getTelephonyAdapter("sarvam") as SarvamTelephonyAdapter;
    },
  );
  assert.ok(adapter instanceof SarvamTelephonyAdapter);
  assert.equal(
    adapter.verifyWebhookSignature(
      "",
      {},
      new URL(
        "https://vaani.app/api/public/webhooks/telephony?provider=sarvam&verify_token=sarvam-shared-secret",
      ),
    ),
    true,
    "the env var must reach the adapter's config, not just be read and discarded",
  );
  assert.equal(
    adapter.verifyWebhookSignature(
      "",
      {},
      new URL("https://vaani.app/api/public/webhooks/telephony?provider=sarvam&verify_token=wrong"),
    ),
    false,
  );
});

test("getTelephonyAdapter('sarvam'): SARVAM_ORG_ID/SARVAM_WORKSPACE_ID are optional — the adapter still constructs without them (webhook processing needs neither)", () => {
  withEnv(
    { SARVAM_API_KEY: "sk_live_example", SARVAM_ORG_ID: undefined, SARVAM_WORKSPACE_ID: undefined },
    () => {
      const adapter = getTelephonyAdapter("sarvam");
      assert.ok(adapter instanceof SarvamTelephonyAdapter);
    },
  );
});

test("getTelephonyAdapter('sarvam'): SARVAM_ORG_ID/SARVAM_WORKSPACE_ID, when set, actually reach the adapter's config", async () => {
  // withEnv itself is synchronous — the adapter's constructor captures
  // orgId/workspaceId into its own config by value at construction time
  // (synchronously, inside withEnv's callback), so the async assertion
  // below is deliberately run AFTER withEnv has already restored the
  // environment — it doesn't need the env vars live, only the adapter
  // instance that already captured them.
  let adapter!: SarvamTelephonyAdapter;
  withEnv(
    { SARVAM_API_KEY: "sk_live_example", SARVAM_ORG_ID: "org_1", SARVAM_WORKSPACE_ID: "ws_1" },
    () => {
      adapter = getTelephonyAdapter("sarvam") as SarvamTelephonyAdapter;
    },
  );
  assert.ok(adapter instanceof SarvamTelephonyAdapter);

  // With org/workspace configured, createInboundDeployment must actually
  // attempt a request (using the org_1/ws_1 it captured) rather than
  // rejecting with the "not configured" error — proving the env vars
  // reached the adapter's config. The global fetch is swapped out for the
  // duration of this call only, so this stays a deterministic unit test
  // rather than a real network call to apps.sarvam.ai.
  const originalFetch = globalThis.fetch;
  let calledUrl: string | undefined;
  globalThis.fetch = (async (url: string | URL) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ deployment_id: "dep_1" }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await adapter.createInboundDeployment({
      name: "n",
      appId: "a",
      appVersion: 1,
      connectionId: "c",
      phoneNumbers: ["+911111111111"],
    });
    assert.equal(result.deploymentId, "dep_1");
    assert.equal(
      calledUrl,
      "https://apps.sarvam.ai/api/app-authoring/v1/orgs/org_1/workspaces/ws_1/deployments",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
