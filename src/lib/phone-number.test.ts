import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCallerId,
  normalizeCustomerPhone,
  normalizePhoneNumber,
  phoneLastFour,
} from "./phone-number.ts";
import {
  CALLER_ID_QUESTION,
  applyCallerIdOffer,
  emptyAppointmentState,
  isClosingUtterance,
  mergeAppointmentState,
  nextMissingDetailQuestion,
  parseCallerIntentFromText,
  resolveCallerIdAnswer,
  type AppointmentState,
} from "./voice-runtime.server.ts";

const E164 = /^\+[1-9]\d{6,14}$/; // contacts_phone_e164

describe("normalizePhoneNumber — E.164 only, national numbers only with a known country", () => {
  for (const [raw, expected] of [
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["098765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["022 2345 6789", "+912223456789"],
    ["+91 98765 43210", "+919876543210"],
    ["0091 98765 43210", "+919876543210"],
    ["+1 (415) 555-0100", "+14155550100"],
  ] as const) {
    test(`India: ${raw} -> ${expected}`, () => {
      const normalized = normalizeCustomerPhone(raw, "IN");
      assert.equal(normalized, expected);
      assert.match(normalized!, E164);
    });
  }
  test("the country code is matched case-insensitively (IN, in, India)", () => {
    for (const country of ["IN", "in", "India", "IND"]) {
      assert.equal(normalizeCustomerPhone("9876543210", country), "+919876543210");
    }
  });
  for (const country of [null, undefined, "", "US", "GB"]) {
    test(`a national-format number is NOT given +91 when the country is ${JSON.stringify(country)}`, () => {
      assert.deepEqual(normalizePhoneNumber("9876543210", country), {
        ok: false,
        reason: "country_code_required",
      });
      // An international-format number works whatever the country.
      assert.equal(normalizeCustomerPhone("+14155550100", country), "+14155550100");
      assert.equal(normalizeCustomerPhone("+919876543210", country), "+919876543210");
    });
  }
  for (const raw of [
    "12345678", // too short for India
    "5876543210", // 10 digits but not an Indian mobile prefix
    "7900",
    "+9198765", // +91 with too few digits
    "+910987654321", // +91 national part starting with 0
    "98765abc10", // letters are not silently dropped
    "",
    "abc",
    null,
    undefined,
  ]) {
    test(`India: rejects ${JSON.stringify(raw)} as invalid`, () => {
      assert.deepEqual(normalizePhoneNumber(raw, "IN"), { ok: false, reason: "invalid" });
    });
  }
});

describe("normalizeCallerId — trusted webhook `From`, withheld/malformed rejected", () => {
  test("a provider E.164 number is kept", () => {
    assert.equal(normalizeCallerId("+919876543210", "IN"), "+919876543210");
    assert.equal(normalizeCallerId("+919876543210", null), "+919876543210");
  });
  test("a provider national-format number is normalized only for an Indian business", () => {
    assert.equal(normalizeCallerId("09876543210", "IN"), "+919876543210");
    assert.equal(normalizeCallerId("09876543210", null), null);
  });
  for (const raw of [
    "anonymous",
    "Private",
    "UNKNOWN",
    "withheld",
    "+12",
    "+910000000000",
    "",
    "  ",
    null,
    undefined,
  ]) {
    test(`unusable caller ID ${JSON.stringify(raw)} -> null`, () => {
      assert.equal(normalizeCallerId(raw, "IN"), null);
    });
  }
  test("only the last four digits are exposed for prompts/logs", () => {
    assert.equal(phoneLastFour("+919876543210"), "3210");
  });
});

function withState(overrides: Partial<AppointmentState>): AppointmentState {
  return { ...emptyAppointmentState(), ...overrides };
}

describe("resolveCallerIdAnswer", () => {
  const offered = withState({ callerIdChoice: "offered" });
  const callerId = "+919876543210";

  for (const text of [
    "Yes",
    "Sure, use it",
    "That's fine",
    "Yes please, the same number",
    "Okay",
  ]) {
    test(`accepts: ${text}`, () => {
      assert.deepEqual(resolveCallerIdAnswer(text, offered, callerId), {
        callerIdChoice: "accepted",
        phone: callerId,
        phoneSource: "caller_id",
        phoneIssue: null,
      });
    });
  }
  for (const text of [
    "No",
    "Use a different number",
    "Yes but another number please",
    "Not that one",
  ]) {
    test(`declines: ${text}`, () => {
      assert.deepEqual(resolveCallerIdAnswer(text, offered, callerId), {
        callerIdChoice: "declined",
      });
    });
  }
  test("a spoken number is taken (normalized) as the caller's choice", () => {
    assert.deepEqual(resolveCallerIdAnswer("Use 98450 12345 instead", offered, callerId, "IN"), {
      callerIdChoice: "declined",
      phone: "+919845012345",
      phoneSource: "caller_provided",
      phoneIssue: null,
    });
  });
  test("a malformed spoken number flags a targeted re-ask", () => {
    assert.deepEqual(resolveCallerIdAnswer("Use 12345 678", offered, callerId, "IN"), {
      callerIdChoice: "declined",
      phoneIssue: "invalid",
    });
  });
  test("ambiguous -> one clarification, then fall back to asking normally", () => {
    assert.deepEqual(resolveCallerIdAnswer("I'm not sure", offered, callerId), {
      callerIdChoice: "clarifying",
    });
    assert.deepEqual(
      resolveCallerIdAnswer("Hmm", withState({ callerIdChoice: "clarifying" }), callerId),
      { callerIdChoice: "declined" },
    );
  });
  test("ignored when not pending, when a number is already known, or without caller ID", () => {
    assert.equal(
      resolveCallerIdAnswer("Yes", withState({ callerIdChoice: "not_offered" }), callerId),
      null,
    );
    assert.equal(
      resolveCallerIdAnswer("Yes", { ...offered, phone: "+919845012345" }, callerId),
      null,
    );
    assert.equal(resolveCallerIdAnswer("Yes", offered, null), null);
  });
});

describe("applyCallerIdOffer", () => {
  const notOffered = withState({ callerIdChoice: "not_offered" });
  test("replaces only the phone-request sentence with the caller-ID question", () => {
    const result = applyCallerIdOffer("6:30 PM works. What's your phone number?", notOffered);
    assert.equal(result.offered, true);
    assert.equal(result.reply, `6:30 PM works. ${CALLER_ID_QUESTION}`);
  });
  test("leaves replies that don't ask for a number untouched", () => {
    const result = applyCallerIdOffer("Which service would you like?", notOffered);
    assert.deepEqual(result, { reply: "Which service would you like?", offered: false });
  });
  test("never rewrites once offered/answered, or without caller ID", () => {
    for (const callerIdChoice of ["unavailable", "offered", "accepted", "declined"] as const) {
      const result = applyCallerIdOffer("What's your phone number?", withState({ callerIdChoice }));
      assert.equal(result.offered, false);
    }
  });
});

describe("nextMissingDetailQuestion — exactly one targeted question", () => {
  const complete = withState({
    service: "cleaning",
    customerName: "Dhanush",
    preferredDate: "2026-10-12",
    preferredTime: "18:30",
  });
  test("only the phone is missing, caller ID available -> the caller-ID question", () => {
    assert.equal(
      nextMissingDetailQuestion({ ...complete, callerIdChoice: "not_offered" }),
      CALLER_ID_QUESTION,
    );
  });
  test("only the phone is missing, no caller ID -> asks for a number", () => {
    assert.match(nextMissingDetailQuestion(complete)!, /phone number/i);
  });
  test("an invalid number -> asks only for the number again", () => {
    assert.match(
      nextMissingDetailQuestion({ ...complete, phoneIssue: "invalid" })!,
      /phone number again/i,
    );
  });
  test("nothing missing -> null", () => {
    assert.equal(nextMissingDetailQuestion({ ...complete, phone: "+919876543210" }), null);
  });
});

describe("mergeAppointmentState — phone safety", () => {
  test("a caller-approved caller-ID number is not replaced by a stray digit run", () => {
    const approved = withState({
      phone: "+919876543210",
      phoneSource: "caller_id",
      callerIdChoice: "accepted",
    });
    const next = mergeAppointmentState(approved, null, {
      phone: "4455667788",
      phoneMentioned: false,
      phoneCountry: "IN",
    });
    assert.equal(next.phone, "+919876543210");
  });
  test("…but IS replaced when the caller explicitly gives a new phone number", () => {
    const approved = withState({
      phone: "+919876543210",
      phoneSource: "caller_id",
      callerIdChoice: "accepted",
    });
    const next = mergeAppointmentState(approved, null, {
      phone: "9845012345",
      phoneMentioned: true,
      phoneCountry: "IN",
    });
    assert.equal(next.phone, "+919845012345");
    assert.equal(next.phoneSource, "caller_provided");
  });
  test("an empty or invalid marker value never overwrites a known number", () => {
    const known = withState({ phone: "+919876543210", phoneSource: "caller_provided" });
    assert.equal(mergeAppointmentState(known, { phone: "" }).phone, "+919876543210");
    assert.equal(mergeAppointmentState(known, { phone: "7900" }).phone, "+919876543210");
  });
  test("an invalid extraction with no known number flags phoneIssue and stores nothing", () => {
    const next = mergeAppointmentState(emptyAppointmentState(), null, {
      phone: "12345678",
      phoneCountry: "IN",
    });
    assert.equal(next.phone, null);
    assert.equal(next.phoneIssue, "invalid");
  });
  test("a national number with no known business country asks for the country code — never a guessed +91", () => {
    const next = mergeAppointmentState(emptyAppointmentState(), null, { phone: "9876543210" });
    assert.equal(next.phone, null);
    assert.equal(next.phoneIssue, "country_code_required");
    assert.match(
      nextMissingDetailQuestion({
        ...next,
        service: "x",
        customerName: "y",
        preferredDate: "2030-01-01",
        preferredTime: "10:00",
      })!,
      /country code/i,
    );
  });
  test("phoneMentioned is detected from the caller's words", () => {
    assert.equal(parseCallerIntentFromText("my number is 98765 43210").phoneMentioned, true);
    assert.equal(parseCallerIntentFromText("policy 4455667788").phoneMentioned, false);
  });
});

describe("isClosingUtterance", () => {
  const none = {
    availabilityRequested: false,
    explicitTime: null,
    relativeDate: null,
    weekday: null,
  };
  test("goodbye always closes", () =>
    assert.equal(isClosingUtterance("okay bye", false, none), true));
  test("'no, that's all' closes only after the anything-else question", () => {
    assert.equal(isClosingUtterance("No, that's all, thanks", true, none), true);
    assert.equal(isClosingUtterance("No", false, none), false);
  });
  test("'thanks' followed by a new question is not a goodbye", () => {
    assert.equal(isClosingUtterance("Thanks, can I also ask about prices?", true, none), false);
    assert.equal(isClosingUtterance("Thank you", true, none), true);
  });
  test("a new request in the same breath is never a hangup", () => {
    assert.equal(
      isClosingUtterance("No, actually can I also book Friday?", true, {
        ...none,
        weekday: { weekday: 5, forceNextWeek: false },
      }),
      false,
    );
  });
});
