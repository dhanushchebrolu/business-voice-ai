/**
 * Browser-side Meta Embedded Signup v4 integration. Loads the Facebook JS
 * SDK, calls FB.login() with the configured config_id, and reconciles it
 * with the separate WA_EMBEDDED_SIGNUP postMessage event Meta uses to
 * deliver the WhatsApp-specific identifiers — FB.login's own callback only
 * ever returns the authorization code, never waba_id/phone_number_id.
 *
 * VERIFICATION STATUS: WebFetch is blocked for every external domain in
 * this sandbox (confirmed again this phase, including developers.
 * facebook.com) — this shape is reconstructed from WebSearch snippets
 * cross-referencing Meta's own indexed doc text and several current
 * (2025-2026) third-party integration guides, not a byte-for-byte read of
 * the primary source. Specifically, with multiple corroborating sources:
 *   - SDK script: https://connect.facebook.net/en_US/sdk.js
 *   - window.fbAsyncInit -> FB.init({ appId, cookie: true, xfbml: true,
 *     version })
 *   - FB.login(callback, { config_id, response_type: "code",
 *     override_default_response_type: true }) — under Embedded Signup v4
 *     the Builder configuration (config_id) controls products/assets/
 *     permissions, not inline JS parameters, matching the brief's own
 *     expected shape.
 *   - A separate `window.addEventListener("message", ...)` listener:
 *     event.origin must end with "facebook.com"; event.data arrives as a
 *     JSON STRING (must be JSON.parsed, not read as an object directly),
 *     shaped `{ type: "WA_EMBEDDED_SIGNUP", event: "FINISH" |
 *     "FINISH_ONLY_WABA" | "CANCEL", data: { waba_id, phone_number_id,
 *     current_step, ... } }`.
 * NOT independently confirmed: the exact field name/casing beyond what
 * multiple sources agreed on above, and whether any additional fields
 * exist in `data` for accounts onboarded under Meta's newer WAAC/Messaging
 * Account architecture (checked separately before this phase — no
 * evidence found of it changing this specific payload; see the Phase 3
 * verification note in the conversation, not duplicated here).
 *
 * This module reconciles BOTH channels: onboarding is not considered
 * complete until it has the authorization code (from FB.login's callback)
 * AND a FINISH message carrying both waba_id and phone_number_id (from
 * the postMessage listener) — in either arrival order. "FINISH_ONLY_WABA"
 * (a WABA was created but no phone number was chosen) and "CANCEL" are
 * both treated as incomplete, never silently coerced into a completion.
 *
 * NEVER calls the Meta Graph API itself and NEVER duplicates Phase 2's
 * onboarding logic. Its only output is the minimal, non-sensitive
 * { code, wabaId, phoneNumberId } tuple the existing Phase 2
 * completeWhatsAppOnboarding server function already accepts.
 */

export interface EmbeddedSignupConfig {
  appId: string;
  configId: string;
  graphApiVersion: string;
}

export interface EmbeddedSignupResult {
  code: string;
  wabaId: string;
  phoneNumberId: string;
}

export type EmbeddedSignupOutcome =
  | { ok: true; result: EmbeddedSignupResult }
  | { ok: false; reason: "cancelled" | "incomplete" | "sdk_error" | "timeout"; message: string };

/** Structural subset of a real postMessage event — avoids depending on the DOM lib's MessageEvent shape so this stays testable under plain Node (no jsdom in this repo's test runner). A genuine browser MessageEvent already satisfies this. */
export interface EmbeddedSignupMessageEvent {
  origin: string;
  data: unknown;
}

/** Injectable window-like surface. The real implementation passes `window`/`document` directly; tests pass a fake. */
export interface EmbeddedSignupWindow {
  addEventListener: (
    type: "message",
    listener: (event: EmbeddedSignupMessageEvent) => void,
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (event: EmbeddedSignupMessageEvent) => void,
  ) => void;
  FB?: {
    init: (opts: { appId: string; cookie: boolean; xfbml: boolean; version: string }) => void;
    login: (
      callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
      opts: { config_id: string; response_type: string; override_default_response_type: boolean },
    ) => void;
  };
}

export interface EmbeddedSignupDeps {
  win: EmbeddedSignupWindow;
  /** Injects the Facebook SDK script (real: appends a <script> tag; tests: resolves immediately and sets win.FB). */
  loadScript: (src: string) => Promise<void>;
  /** Timeout in ms waiting for the FINISH message after FB.login's own callback returns. Defaults to 60000. */
  timeoutMs?: number;
}

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

export async function loadFacebookSdk(
  config: EmbeddedSignupConfig,
  deps: Pick<EmbeddedSignupDeps, "win" | "loadScript">,
): Promise<void> {
  if (!deps.win.FB) {
    await deps.loadScript(SDK_SRC);
  }
  if (!deps.win.FB) {
    throw new Error("Meta's SDK did not load.");
  }
  deps.win.FB.init({
    appId: config.appId,
    cookie: true,
    xfbml: true,
    version: config.graphApiVersion,
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export interface ParsedEmbeddedSignupMessage {
  event: "FINISH" | "FINISH_ONLY_WABA" | "CANCEL";
  wabaId: string | null;
  phoneNumberId: string | null;
}

/**
 * Parses one raw window "message" event into a WA_EMBEDDED_SIGNUP outcome,
 * or null if this event isn't one (a message from an unrelated origin, or
 * one that doesn't match the expected shape at all — never guessed at).
 */
export function parseEmbeddedSignupMessage(
  event: EmbeddedSignupMessageEvent,
): ParsedEmbeddedSignupMessage | null {
  if (!event.origin.endsWith("facebook.com")) return null;

  let parsed: unknown = event.data;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || parsed["type"] !== "WA_EMBEDDED_SIGNUP") return null;

  const eventName = parsed["event"];
  if (eventName !== "FINISH" && eventName !== "FINISH_ONLY_WABA" && eventName !== "CANCEL") {
    return null;
  }

  const data = isRecord(parsed["data"]) ? parsed["data"] : {};
  const wabaId = typeof data["waba_id"] === "string" ? data["waba_id"] : null;
  const phoneNumberId =
    typeof data["phone_number_id"] === "string" ? data["phone_number_id"] : null;
  return { event: eventName, wabaId, phoneNumberId };
}

/**
 * Runs the full Embedded Signup v4 flow: loads the SDK, opens FB.login,
 * and resolves once both the authorization code and a FINISH message with
 * waba_id/phone_number_id have arrived (in either order) — or once the
 * flow is cancelled, comes back incomplete, or times out. Never throws;
 * every outcome is a typed EmbeddedSignupOutcome so the caller always has
 * a concrete state to render.
 */
export async function startWhatsAppEmbeddedSignup(
  config: EmbeddedSignupConfig,
  deps: EmbeddedSignupDeps,
): Promise<EmbeddedSignupOutcome> {
  try {
    await loadFacebookSdk(config, deps);
  } catch (err) {
    return {
      ok: false,
      reason: "sdk_error",
      message: err instanceof Error ? err.message : "Meta's SDK failed to load.",
    };
  }

  const FB = deps.win.FB;
  if (!FB) {
    return { ok: false, reason: "sdk_error", message: "Meta's SDK is not available." };
  }

  return new Promise((resolve) => {
    let code: string | null = null;
    let finish: { wabaId: string; phoneNumberId: string } | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      settle({
        ok: false,
        reason: "timeout",
        message: "WhatsApp connection timed out. Please try again.",
      });
    }, deps.timeoutMs ?? 60_000);

    function settle(outcome: EmbeddedSignupOutcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.win.removeEventListener("message", onMessage);
      resolve(outcome);
    }

    function tryComplete() {
      if (code && finish) {
        settle({
          ok: true,
          result: { code, wabaId: finish.wabaId, phoneNumberId: finish.phoneNumberId },
        });
      }
    }

    function onMessage(event: EmbeddedSignupMessageEvent) {
      const parsedMsg = parseEmbeddedSignupMessage(event);
      if (!parsedMsg) return;

      if (parsedMsg.event === "CANCEL") {
        settle({ ok: false, reason: "cancelled", message: "WhatsApp connection was cancelled." });
        return;
      }
      if (parsedMsg.event === "FINISH_ONLY_WABA" || !parsedMsg.wabaId || !parsedMsg.phoneNumberId) {
        settle({
          ok: false,
          reason: "incomplete",
          message: "No WhatsApp phone number was selected. Please try again and choose a number.",
        });
        return;
      }
      finish = { wabaId: parsedMsg.wabaId, phoneNumberId: parsedMsg.phoneNumberId };
      tryComplete();
    }

    deps.win.addEventListener("message", onMessage);

    FB.login(
      (response) => {
        if (!response?.authResponse?.code) {
          settle({ ok: false, reason: "cancelled", message: "WhatsApp connection was cancelled." });
          return;
        }
        code = response.authResponse.code;
        tryComplete();
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
      },
    );
  });
}
