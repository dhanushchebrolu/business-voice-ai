import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES,
  CAPABILITY_PERMISSION_KEYS,
  isCapabilityEnabled,
  deriveBackendPermissions,
} from "./business-types.ts";

/**
 * Production incident (see the appointment/calendar reliability audit):
 * the dashboard's own capability toggle ids (book_appointment,
 * check_availability, reschedule_appointment, cancel_appointment) never
 * matched the backend permission keys calendar-tools.server.ts/
 * ai-tools.server.ts/agent-instructions.ts actually check
 * (calendar_book/calendar_read/calendar_reschedule/calendar_cancel) — so
 * toggling a calendar capability on in the dashboard never actually
 * granted the permission it claimed to. These tests cover the
 * reconciliation layer directly, both enabled and disabled.
 */

describe("CAPABILITY_PERMISSION_KEYS — exactly the four calendar toggles map to the backend's own permission keys", () => {
  test("maps every calendar-requiring capability id to its backend permission key", () => {
    assert.deepEqual(CAPABILITY_PERMISSION_KEYS, {
      check_availability: "calendar_read",
      book_appointment: "calendar_book",
      reschedule_appointment: "calendar_reschedule",
      cancel_appointment: "calendar_cancel",
    });
  });

  test("every mapped id is a real capability this dashboard actually renders", () => {
    const ids = new Set(CAPABILITIES.map((c) => c.id));
    for (const uiKey of Object.keys(CAPABILITY_PERMISSION_KEYS)) {
      assert.ok(ids.has(uiKey), `${uiKey} must be a real CAPABILITIES entry`);
    }
  });

  test("non-calendar capabilities (answer_faqs, take_callback, ...) have no backend permission mapping", () => {
    for (const cap of CAPABILITIES) {
      if (cap.requires === "calendar") continue;
      assert.equal(
        CAPABILITY_PERMISSION_KEYS[cap.id],
        undefined,
        `${cap.id} must not be remapped — it isn't a calendar permission`,
      );
    }
  });
});

describe("deriveBackendPermissions — write path: UI toggle booleans become the exact backend keys", () => {
  test("an ENABLED calendar toggle derives its backend key as true", () => {
    const derived = deriveBackendPermissions({ book_appointment: true });
    assert.equal(derived["calendar_book"], true);
  });

  test("a DISABLED calendar toggle derives its backend key as false — revokes, not just grants", () => {
    const derived = deriveBackendPermissions({ book_appointment: false });
    assert.equal(derived["calendar_book"], false);
  });

  test("all four calendar toggles derive independently in one call", () => {
    const derived = deriveBackendPermissions({
      check_availability: true,
      book_appointment: true,
      reschedule_appointment: false,
      cancel_appointment: true,
    });
    assert.deepEqual(derived, {
      calendar_read: true,
      calendar_book: true,
      calendar_reschedule: false,
      calendar_cancel: true,
    });
  });

  test("a capability id with no backend mapping (answer_faqs) is never added to the derived output", () => {
    const derived = deriveBackendPermissions({ answer_faqs: true, book_appointment: true });
    assert.deepEqual(derived, { calendar_book: true });
  });

  test("a calendar key absent from the input is left out of the derived output entirely, not forced to false", () => {
    const derived = deriveBackendPermissions({ book_appointment: true });
    assert.equal("calendar_read" in derived, false);
    assert.equal("calendar_reschedule" in derived, false);
    assert.equal("calendar_cancel" in derived, false);
  });

  test("merging the derived keys into the UI's own capabilities preserves both — the original toggle id is never dropped", () => {
    const uiCapabilities: Record<string, boolean> = { book_appointment: true, answer_faqs: true };
    const stored = { ...uiCapabilities, ...deriveBackendPermissions(uiCapabilities) };
    assert.equal(stored["book_appointment"], true, "UI's own key must survive the merge");
    assert.equal(stored["answer_faqs"], true);
    assert.equal(stored["calendar_book"], true, "backend key must be derived and merged in");
  });
});

describe("isCapabilityEnabled — read path: a toggle reads as on from either its own key or the backend key", () => {
  test("ENABLED via the UI's own key only", () => {
    assert.equal(isCapabilityEnabled({ book_appointment: true }, "book_appointment"), true);
  });

  test("ENABLED via the backend key only (e.g. set directly on the row before this reconciliation existed)", () => {
    assert.equal(isCapabilityEnabled({ calendar_book: true }, "book_appointment"), true);
  });

  test("DISABLED when neither key is present", () => {
    assert.equal(isCapabilityEnabled({}, "book_appointment"), false);
  });

  test("DISABLED when both keys are explicitly false", () => {
    assert.equal(
      isCapabilityEnabled({ book_appointment: false, calendar_book: false }, "book_appointment"),
      false,
    );
  });

  test("a non-calendar capability (no backend mapping) reads purely from its own key", () => {
    assert.equal(isCapabilityEnabled({ answer_faqs: true }, "answer_faqs"), true);
    assert.equal(isCapabilityEnabled({ answer_faqs: false }, "answer_faqs"), false);
  });

  test("each of the four calendar capabilities round-trips through derive -> isCapabilityEnabled", () => {
    for (const uiKey of Object.keys(CAPABILITY_PERMISSION_KEYS)) {
      const enabled = deriveBackendPermissions({ [uiKey]: true });
      assert.equal(isCapabilityEnabled(enabled, uiKey), true, `${uiKey} must read back as enabled`);

      const disabled = deriveBackendPermissions({ [uiKey]: false });
      assert.equal(
        isCapabilityEnabled(disabled, uiKey),
        false,
        `${uiKey} must read back as disabled`,
      );
    }
  });
});
