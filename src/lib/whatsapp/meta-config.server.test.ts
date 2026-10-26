import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveMetaWhatsAppConfig, validateMetaWhatsAppEnv } from "./meta-config.server.ts";

/**
 * The server-side half of "WhatsApp is not configured on this deployment
 * yet": onboarding refuses to start unless all four Worker secrets are set,
 * and logs only the missing NAMES. (The browser half is the three
 * VITE_META_* build-time variables checked in app.whatsapp.tsx and reported
 * by vite.config.ts's build-env diagnostic.)
 */

const NAMES = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_WHATSAPP_CONFIG_ID",
  "META_GRAPH_API_VERSION",
] as const;
const VALUES: Record<(typeof NAMES)[number], string> = {
  META_APP_ID: "1234567890",
  META_APP_SECRET: "super-secret-app-secret-value",
  META_WHATSAPP_CONFIG_ID: "987654321",
  META_GRAPH_API_VERSION: "v23.0",
};

const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
function setEnv(values: Partial<Record<(typeof NAMES)[number], string | undefined>>) {
  for (const name of NAMES) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
}
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("Meta WhatsApp configuration", () => {
  test("all four set: resolved config, nothing missing", () => {
    setEnv(VALUES);
    assert.deepEqual(validateMetaWhatsAppEnv().missing, []);
    assert.deepEqual(resolveMetaWhatsAppConfig(), {
      appId: VALUES.META_APP_ID,
      appSecret: VALUES.META_APP_SECRET,
      configId: VALUES.META_WHATSAPP_CONFIG_ID,
      graphApiVersion: VALUES.META_GRAPH_API_VERSION,
    });
  });

  test("any one missing (or empty): not configured, and exactly that name is reported", () => {
    for (const name of NAMES) {
      for (const absent of [undefined, ""]) {
        setEnv({ ...VALUES, [name]: absent });
        const validation = validateMetaWhatsAppEnv();
        assert.equal(validation.allPresent, false, name);
        assert.deepEqual(validation.missing, [name]);
        assert.equal(resolveMetaWhatsAppConfig(), null, name);
      }
    }
  });

  test("the validation result carries names and booleans only, never a value", () => {
    setEnv({ ...VALUES, META_GRAPH_API_VERSION: undefined });
    const serialized = JSON.stringify(validateMetaWhatsAppEnv());
    for (const value of Object.values(VALUES)) assert.ok(!serialized.includes(value), value);
  });
});
