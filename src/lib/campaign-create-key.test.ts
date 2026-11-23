import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CAMPAIGN_CREATE_KEY_STORAGE,
  CAMPAIGN_IDEMPOTENCY_KEY_PATTERN,
  claimCampaignCreateKey,
  holdCampaignCreateKey,
  releaseCampaignCreateKey,
} from "./campaign-create-key.ts";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("campaign creation key lifecycle", () => {
  test("a new session gets a valid key, stored for this tab", () => {
    const s = memoryStorage();
    const key = claimCampaignCreateKey(s);
    assert.match(key, CAMPAIGN_IDEMPOTENCY_KEY_PATTERN);
    assert.equal(s.map.get(CAMPAIGN_CREATE_KEY_STORAGE), key);
  });

  test("a refresh (claim again without leaving) reuses the same key", () => {
    const s = memoryStorage();
    const first = claimCampaignCreateKey(s);
    assert.equal(claimCampaignCreateKey(s), first);
  });

  test("leaving the wizard releases the key, so the next creation gets a new one", async () => {
    const s = memoryStorage();
    const first = claimCampaignCreateKey(s);
    releaseCampaignCreateKey(s);
    await tick();
    assert.equal(s.map.has(CAMPAIGN_CREATE_KEY_STORAGE), false);
    assert.notEqual(claimCampaignCreateKey(s), first);
  });

  test("a remount right after an unmount keeps the key (the release is cancelled)", async () => {
    const s = memoryStorage();
    const key = claimCampaignCreateKey(s);
    releaseCampaignCreateKey(s);
    holdCampaignCreateKey(key, s);
    await tick();
    assert.equal(s.map.get(CAMPAIGN_CREATE_KEY_STORAGE), key);
  });

  test("a malformed stored value is replaced, never sent", () => {
    const s = memoryStorage();
    s.map.set(CAMPAIGN_CREATE_KEY_STORAGE, "bad key!");
    const key = claimCampaignCreateKey(s);
    assert.match(key, CAMPAIGN_IDEMPOTENCY_KEY_PATTERN);
    assert.notEqual(key, "bad key!");
  });

  test("storage that throws (private mode, blocked data) never crashes the wizard", async () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const key = claimCampaignCreateKey(broken);
    assert.match(key, CAMPAIGN_IDEMPOTENCY_KEY_PATTERN);
    assert.doesNotThrow(() => holdCampaignCreateKey(key, broken));
    assert.doesNotThrow(() => releaseCampaignCreateKey(broken));
    await tick();
    assert.match(claimCampaignCreateKey(null), CAMPAIGN_IDEMPOTENCY_KEY_PATTERN);
  });
});
