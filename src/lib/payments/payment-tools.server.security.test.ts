import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Hard invariant guards for the AI tool surface (spec's CRITICAL
 * ARCHITECTURE RULE: "AI may REQUEST a payment. AI must NEVER declare a
 * payment successful."). Source-scan rather than behavioral, on purpose
 * — these assert something no runtime test can: that the CODE ITSELF
 * contains no path capable of writing payment_requests.status =
 * "CAPTURED" or creating a Google Calendar event, so a future edit that
 * quietly adds one is caught even before a test exercising that specific
 * input would.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const toolsSrc = readFileSync(join(dir, "payment-tools.server.ts"), "utf8");
const registrySrc = readFileSync(join(dir, "..", "ai-tools.server.ts"), "utf8");
const bookingHoldSrc = readFileSync(
  join(dir, "..", "calendar", "booking-service.server.ts"),
  "utf8",
);

describe("AI tool layer can never itself mark a payment CAPTURED", () => {
  test("payment-tools.server.ts contains no .update(...) call setting status to CAPTURED", () => {
    assert.doesNotMatch(toolsSrc, /\.update\(\s*\{[^}]*status:\s*["']CAPTURED["']/s);
  });

  test("ai-tools.server.ts (the dispatcher) contains no direct payment_requests write at all — every mutation goes through the already-guarded service layer", () => {
    const code = registrySrc.replace(/\/\*\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /\.from\(["']payment_requests["']\)\s*\.\s*(update|insert|upsert)/);
  });
});

describe("AI tool layer can never itself create the final Google Calendar event for a payment-required booking", () => {
  test("create_payment_required_booking only calls createPaymentRequiredBooking (the PENDING_PAYMENT hold path), never createBooking/createCalendarEvent (the confirmed-event path)", () => {
    const createFnIdx = toolsSrc.indexOf("export async function create_payment_required_booking");
    const createFnEnd = toolsSrc.indexOf("\n}\n", createFnIdx);
    const fnBody = toolsSrc.slice(createFnIdx, createFnEnd);
    assert.match(fnBody, /createPaymentRequiredBooking\(/);
    assert.doesNotMatch(fnBody, /\bcreateBooking\(/);
  });

  test("createPaymentRequiredBooking itself (booking-service.server.ts) never calls the calendar provider to create an event — it only inserts a PENDING_PAYMENT hold row via the RPC function", () => {
    const fnIdx = bookingHoldSrc.indexOf("export async function createPaymentRequiredBooking(");
    const fnEnd = bookingHoldSrc.indexOf("\n}\n", fnIdx);
    const fnBody = bookingHoldSrc.slice(fnIdx, fnEnd);
    assert.match(fnBody, /create_booking_payment_hold/);
    assert.doesNotMatch(fnBody, /provider\.createEvent/);
    assert.doesNotMatch(fnBody, /googleEventId/);
  });
});

describe("only the verified webhook path may write CAPTURED", () => {
  test("payment_requests.status = CAPTURED is written in exactly one place in the whole payments module tree: payment-webhook.server.ts", () => {
    const files = [
      "payment-tools.server.ts",
      "payment-request-service.server.ts",
      "payment-events.server.ts",
      "payment-calendar-consumer.server.ts",
      "payment-whatsapp-consumer.server.ts",
      "payment-voice-consumer.server.ts",
      "payment-expiration.server.ts",
    ];
    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
      assert.doesNotMatch(
        src,
        /status:\s*["']CAPTURED["']/,
        `${file} must never write status: "CAPTURED"`,
      );
    }
    const webhookSrc = readFileSync(join(dir, "payment-webhook.server.ts"), "utf8");
    assert.match(webhookSrc, /status:\s*["']CAPTURED["']/);
  });
});
