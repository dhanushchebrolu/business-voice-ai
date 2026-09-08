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

test("TELEPHONY_PROVIDERS: the sarvam entry requires only SARVAM_API_KEY", () => {
  const def = TELEPHONY_PROVIDERS.find((p) => p.id === "sarvam");
  assert.ok(def, "expected a sarvam entry in the provider registry");
  assert.deepEqual(def.requiredSecrets, ["SARVAM_API_KEY"]);
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

test("providerStatus: sarvam reports configured once SARVAM_API_KEY is set, and not before", () => {
  withEnv({ SARVAM_API_KEY: undefined }, () => {
    const before = providerStatus().find((p) => p.id === "sarvam");
    assert.equal(before?.configured, false);
    assert.deepEqual(before?.missing, ["SARVAM_API_KEY"]);
  });
  withEnv({ SARVAM_API_KEY: "sk_live_example" }, () => {
    const after = providerStatus().find((p) => p.id === "sarvam");
    assert.equal(after?.configured, true);
    assert.deepEqual(after?.missing, []);
  });
});

test("getTelephonyAdapter('sarvam'): returns null when SARVAM_API_KEY is missing, never a half-configured adapter", () => {
  withEnv({ SARVAM_API_KEY: undefined }, () => {
    assert.equal(getTelephonyAdapter("sarvam"), null);
  });
});

test("getTelephonyAdapter('sarvam'): returns a real SarvamTelephonyAdapter once SARVAM_API_KEY is set", () => {
  withEnv({ SARVAM_API_KEY: "sk_live_example" }, () => {
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
  // With org/workspace configured, createInboundDeployment must fail for
  // the "not implemented" reason, not the "not configured" one — proving
  // the env vars actually reached the adapter's config.
  await assert.rejects(
    () =>
      adapter.createInboundDeployment({
        name: "n",
        appId: "a",
        appVersion: 1,
        connectionId: "c",
        phoneNumbers: ["+911111111111"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /not implemented/i);
      return true;
    },
  );
});
