import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadFacebookSdk,
  parseEmbeddedSignupMessage,
  startWhatsAppEmbeddedSignup,
  type EmbeddedSignupWindow,
  type EmbeddedSignupDeps,
} from "./embedded-signup-client.ts";

const config = { appId: "test-app-id", configId: "test-config-id", graphApiVersion: "v23.0" };

/**
 * startWhatsAppEmbeddedSignup is async and registers its "message" listener
 * only after its first `await` resumes — so a test that calls `win.emit(...)`
 * synchronously, right after starting the call, races the listener
 * registration and the emitted message is lost (no listener yet). This
 * flushes the microtask queue first, guaranteeing the listener is
 * registered before emit() is called.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake window: no jsdom in this repo's test runner (see app.numbers.test.ts's convention) — every "browser" surface here is hand-scripted. */
function makeFakeWindow(): EmbeddedSignupWindow & {
  emit: (event: { origin: string; data: unknown }) => void;
  loginCalls: { opts: unknown }[];
  initCalls: unknown[];
} {
  const listeners: ((event: { origin: string; data: unknown }) => void)[] = [];
  let loginResponse: { authResponse?: { code?: string } | null; status?: string } = {
    authResponse: { code: "auth-code-xyz" },
    status: "connected",
  };
  const loginCalls: { opts: unknown }[] = [];
  const initCalls: unknown[] = [];

  const win: EmbeddedSignupWindow & {
    emit: (event: { origin: string; data: unknown }) => void;
    loginCalls: typeof loginCalls;
    initCalls: typeof initCalls;
    setLoginResponse: (r: typeof loginResponse) => void;
  } = {
    addEventListener: (_type, listener) => listeners.push(listener),
    removeEventListener: (_type, listener) => {
      const idx = listeners.indexOf(listener);
      if (idx > -1) listeners.splice(idx, 1);
    },
    FB: {
      init: (opts) => initCalls.push(opts),
      login: (callback, opts) => {
        loginCalls.push({ opts });
        callback(loginResponse);
      },
    },
    emit: (event) => listeners.slice().forEach((l) => l(event)),
    loginCalls,
    initCalls,
    setLoginResponse: (r) => {
      loginResponse = r;
    },
  };
  return win;
}

function finishMessage(wabaId: string, phoneNumberId: string) {
  return {
    origin: "https://www.facebook.com",
    data: JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { waba_id: wabaId, phone_number_id: phoneNumberId, current_step: "PHONE_NUMBER" },
    }),
  };
}

describe("loadFacebookSdk", () => {
  test("calls FB.init with appId, cookie, xfbml, and the configured graphApiVersion", async () => {
    const win = makeFakeWindow();
    await loadFacebookSdk(config, { win, loadScript: async () => {} });
    assert.deepEqual(win.initCalls[0], {
      appId: "test-app-id",
      cookie: true,
      xfbml: true,
      version: "v23.0",
    });
  });

  test("uses the configured graphApiVersion, not a hardcoded one", async () => {
    const win = makeFakeWindow();
    await loadFacebookSdk(
      { ...config, graphApiVersion: "v99.0" },
      { win, loadScript: async () => {} },
    );
    assert.equal((win.initCalls[0] as { version: string }).version, "v99.0");
  });

  test("does not re-load the script if FB is already present", async () => {
    const win = makeFakeWindow();
    let loadCount = 0;
    await loadFacebookSdk(config, {
      win,
      loadScript: async () => {
        loadCount += 1;
      },
    });
    assert.equal(loadCount, 0, "FB was already set on the fake window");
  });

  test("throws if the script loads but FB is still undefined", async () => {
    const win = makeFakeWindow();
    delete (win as { FB?: unknown }).FB;
    await assert.rejects(() =>
      loadFacebookSdk(config, { win, loadScript: async () => {} /* never sets win.FB */ }),
    );
  });
});

describe("parseEmbeddedSignupMessage", () => {
  test("parses a valid FINISH event with waba_id and phone_number_id", () => {
    const result = parseEmbeddedSignupMessage(finishMessage("waba-1", "phone-1"));
    assert.deepEqual(result, { event: "FINISH", wabaId: "waba-1", phoneNumberId: "phone-1" });
  });

  test("rejects a message whose origin is not facebook.com — a malicious page cannot forge this", () => {
    const result = parseEmbeddedSignupMessage({
      origin: "https://evil.example.com",
      data: JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH",
        data: { waba_id: "x", phone_number_id: "y" },
      }),
    });
    assert.equal(result, null);
  });

  test("accepts any subdomain ending in facebook.com (e.g. www.facebook.com)", () => {
    const result = parseEmbeddedSignupMessage(finishMessage("waba-1", "phone-1"));
    assert.notEqual(result, null);
  });

  test("returns null for a message that is valid JSON but not WA_EMBEDDED_SIGNUP shaped — unrelated postMessage traffic must not be misread", () => {
    const result = parseEmbeddedSignupMessage({
      origin: "https://www.facebook.com",
      data: JSON.stringify({ type: "something_else" }),
    });
    assert.equal(result, null);
  });

  test("returns null for malformed (non-JSON) data instead of throwing", () => {
    const result = parseEmbeddedSignupMessage({
      origin: "https://www.facebook.com",
      data: "not valid json {{{",
    });
    assert.equal(result, null);
  });

  test("returns null for an unrecognized event name — never guesses at a new/unknown event", () => {
    const result = parseEmbeddedSignupMessage({
      origin: "https://www.facebook.com",
      data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "SOMETHING_NEW", data: {} }),
    });
    assert.equal(result, null);
  });

  test("CANCEL event parses with null identifiers (current_step only, no waba/phone data)", () => {
    const result = parseEmbeddedSignupMessage({
      origin: "https://www.facebook.com",
      data: JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "CANCEL",
        data: { current_step: "BUSINESS_INFO" },
      }),
    });
    assert.deepEqual(result, { event: "CANCEL", wabaId: null, phoneNumberId: null });
  });

  test("FINISH_ONLY_WABA parses with a wabaId but null phoneNumberId", () => {
    const result = parseEmbeddedSignupMessage({
      origin: "https://www.facebook.com",
      data: JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH_ONLY_WABA",
        data: { waba_id: "waba-1" },
      }),
    });
    assert.deepEqual(result, { event: "FINISH_ONLY_WABA", wabaId: "waba-1", phoneNumberId: null });
  });

  test("also accepts event.data already as an object (not just a JSON string)", () => {
    const result = parseEmbeddedSignupMessage({
      origin: "https://www.facebook.com",
      data: {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH",
        data: { waba_id: "w", phone_number_id: "p" },
      },
    });
    assert.deepEqual(result, { event: "FINISH", wabaId: "w", phoneNumberId: "p" });
  });
});

describe("startWhatsAppEmbeddedSignup: request construction", () => {
  test("calls FB.login with config_id, response_type: 'code', override_default_response_type: true", async () => {
    const win = makeFakeWindow();
    const promise = startWhatsAppEmbeddedSignup(config, { win, loadScript: async () => {} });
    await tick();
    win.emit(finishMessage("waba-1", "phone-1"));
    await promise;
    assert.deepEqual(win.loginCalls[0]!.opts, {
      config_id: "test-config-id",
      response_type: "code",
      override_default_response_type: true,
    });
  });
});

describe("startWhatsAppEmbeddedSignup: successful handoff", () => {
  test("resolves ok:true with {code, wabaId, phoneNumberId} once both the FB.login code and the FINISH message arrive", async () => {
    const win = makeFakeWindow();
    const promise = startWhatsAppEmbeddedSignup(config, { win, loadScript: async () => {} });
    await tick();
    win.emit(finishMessage("waba-42", "phone-42"));
    const outcome = await promise;
    assert.deepEqual(outcome, {
      ok: true,
      result: { code: "auth-code-xyz", wabaId: "waba-42", phoneNumberId: "phone-42" },
    });
  });

  test("resolves correctly even if the FINISH message somehow arrives before FB.login's callback fires", async () => {
    const win = makeFakeWindow();
    // Fire the FINISH message synchronously by wrapping FB.login to emit first.
    const originalLogin = win.FB!.login;
    win.FB!.login = (callback, opts) => {
      win.emit(finishMessage("waba-early", "phone-early"));
      originalLogin(callback, opts);
    };
    const outcome = await startWhatsAppEmbeddedSignup(config, { win, loadScript: async () => {} });
    assert.deepEqual(outcome, {
      ok: true,
      result: { code: "auth-code-xyz", wabaId: "waba-early", phoneNumberId: "phone-early" },
    });
  });

  test("ignores unrelated/malformed messages while waiting for the real FINISH event", async () => {
    const win = makeFakeWindow();
    const promise = startWhatsAppEmbeddedSignup(config, { win, loadScript: async () => {} });
    await tick();
    win.emit({ origin: "https://www.facebook.com", data: "garbage" });
    win.emit({
      origin: "https://evil.example.com",
      data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP" }),
    });
    win.emit(finishMessage("waba-ok", "phone-ok"));
    const outcome = await promise;
    assert.equal(outcome.ok, true);
  });
});

describe("startWhatsAppEmbeddedSignup: failure / incomplete states", () => {
  test("resolves ok:false reason:'cancelled' when FB.login's own callback has no authResponse.code", async () => {
    const win = makeFakeWindow();
    (win as unknown as { setLoginResponse: (r: unknown) => void }).setLoginResponse({
      status: "not_authorized",
    });
    const outcome = await startWhatsAppEmbeddedSignup(config, { win, loadScript: async () => {} });
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { reason: string }).reason, "cancelled");
  });

  test("resolves ok:false reason:'cancelled' on a CANCEL message", async () => {
    const win = makeFakeWindow();
    const promise = startWhatsAppEmbeddedSignup(config, { win, loadScript: async () => {} });
    await tick();
    win.emit({
      origin: "https://www.facebook.com",
      data: JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "CANCEL",
        data: { current_step: "PHONE_NUMBER" },
      }),
    });
    const outcome = await promise;
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { reason: string }).reason, "cancelled");
  });

  test("resolves ok:false reason:'incomplete' on FINISH_ONLY_WABA (no phone number chosen)", async () => {
    const win = makeFakeWindow();
    const promise = startWhatsAppEmbeddedSignup(config, { win, loadScript: async () => {} });
    await tick();
    win.emit({
      origin: "https://www.facebook.com",
      data: JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH_ONLY_WABA",
        data: { waba_id: "waba-1" },
      }),
    });
    const outcome = await promise;
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { reason: string }).reason, "incomplete");
  });

  test("resolves ok:false reason:'sdk_error' when the SDK never loads", async () => {
    const win = makeFakeWindow();
    delete (win as { FB?: unknown }).FB;
    const outcome = await startWhatsAppEmbeddedSignup(config, {
      win,
      loadScript: async () => {},
    });
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { reason: string }).reason, "sdk_error");
  });

  test("resolves ok:false reason:'timeout' if neither a code nor a FINISH message ever arrives", async () => {
    const win = makeFakeWindow();
    // Suppress the callback firing at all (simulate FB.login hanging).
    win.FB!.login = () => {};
    const outcome = await startWhatsAppEmbeddedSignup(config, {
      win,
      loadScript: async () => {},
      timeoutMs: 5,
    });
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { reason: string }).reason, "timeout");
  });
});

describe("no secret exposure", () => {
  test("this module never references META_APP_SECRET, an access token, a system-user token, or an encryption key", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./embedded-signup-client.ts", import.meta.url), "utf8");
    assert.doesNotMatch(
      src,
      /META_APP_SECRET|appSecret|access_?[Tt]oken(?!.*authResponse)|encrypt|WHATSAPP_CREDENTIAL_ENCRYPTION_KEY/,
    );
  });

  test("this module never calls graph.facebook.com or any Meta Graph API directly", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./embedded-signup-client.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /graph\.facebook\.com/);
    assert.doesNotMatch(src, /\bfetch\(/);
  });
});
