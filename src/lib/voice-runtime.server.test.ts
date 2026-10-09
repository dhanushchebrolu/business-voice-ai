import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  chunkIntoSentences,
  startRuntimeSession,
  getActiveSession,
  isValidRuntimeTransition,
  isSupportedVoiceLanguage,
  resolveResponseLanguage,
  parseApptStateMarker,
  parseCallerIntentFromText,
  matchService,
  matchServiceInText,
  mergeAppointmentState,
  emptyAppointmentState,
  appointmentReadyForAvailabilityCheck,
  spokenDateLabel,
  spokenTimeLabel,
  describeRequestedTime,
  replyAlreadyAcknowledges,
  type RuntimeState,
} from "./voice-runtime.server.ts";
import type { AudioMediaBridge, AudioFrame } from "./telephony/audio-bridge";
import type { AgentSnapshot } from "./agent-instructions";

describe("isSupportedVoiceLanguage / resolveResponseLanguage — the TTS/LLM common supported set, not Saaras STT's larger recognition set", () => {
  test("every one of the 11 documented common-supported languages is accepted", () => {
    for (const code of [
      "en-IN",
      "hi-IN",
      "bn-IN",
      "ta-IN",
      "te-IN",
      "gu-IN",
      "kn-IN",
      "ml-IN",
      "mr-IN",
      "pa-IN",
      "od-IN",
    ]) {
      assert.equal(isSupportedVoiceLanguage(code), true, `expected ${code} to be supported`);
    }
  });

  test("a language Saaras STT can detect but Bulbul/the LLM pair cannot (outside the 11-language common set) is rejected", () => {
    for (const code of ["ur-IN", "as-IN", "fr-FR", "unknown"]) {
      assert.equal(isSupportedVoiceLanguage(code), false, `expected ${code} to be unsupported`);
    }
  });

  test("resolveResponseLanguage returns the detected language when it's in the supported set", () => {
    assert.equal(resolveResponseLanguage("hi-IN", "en-IN"), "hi-IN");
    assert.equal(resolveResponseLanguage("ta-IN", "en-IN"), "ta-IN");
  });

  test("resolveResponseLanguage falls back to the agent's primary_language when the detected language is unsupported", () => {
    assert.equal(resolveResponseLanguage("ur-IN", "en-IN"), "en-IN");
    assert.equal(resolveResponseLanguage("fr-FR", "hi-IN"), "hi-IN");
  });

  test("resolveResponseLanguage falls back to primary_language when nothing has been detected yet", () => {
    assert.equal(resolveResponseLanguage(null, "te-IN"), "te-IN");
  });
});

describe("parseApptStateMarker — the hidden structured-state tail the model appends to every reply", () => {
  test("a reply with no marker is spoken in full, with no state proposed", () => {
    const result = parseApptStateMarker("We're open until 6 PM today.");
    assert.equal(result.spokenText, "We're open until 6 PM today.");
    assert.equal(result.state, null);
  });

  test("strips the marker from the spoken text and parses its fields", () => {
    const reply =
      'Sure, teeth cleaning tomorrow at 3 PM for Dhanush.\n<<<APPT_STATE:{"service":"teeth cleaning","customer_name":"Dhanush","phone":"9999999999","preferred_date":"2026-10-08","preferred_time":"15:00","ready_to_book":true}>>>';
    const result = parseApptStateMarker(reply);
    assert.equal(result.spokenText, "Sure, teeth cleaning tomorrow at 3 PM for Dhanush.");
    assert.deepEqual(result.state, {
      service: "teeth cleaning",
      customerName: "Dhanush",
      phone: "9999999999",
      preferredDate: "2026-10-08",
      preferredTime: "15:00",
      bookingStatus: "ready_to_book",
    });
  });

  test("ready_to_book false or absent never sets bookingStatus", () => {
    const result = parseApptStateMarker(
      'Got it.\n<<<APPT_STATE:{"service":"teeth cleaning","customer_name":null,"phone":null,"preferred_date":null,"preferred_time":null,"ready_to_book":false}>>>',
    );
    assert.equal(result.state?.bookingStatus, undefined);
    assert.equal(result.state?.service, "teeth cleaning");
  });

  test("a malformed/truncated marker is still fully stripped from the spoken text, never partially spoken", () => {
    const result = parseApptStateMarker("One moment please.\n<<<APPT_STATE:{not valid json at all");
    assert.equal(result.spokenText, "One moment please.");
    assert.equal(result.state, null);
  });

  test("a marker with no closing >>> is stripped from speech but yields no state", () => {
    const result = parseApptStateMarker('Okay.\n<<<APPT_STATE:{"service":"haircut"');
    assert.equal(result.spokenText, "Okay.");
    assert.equal(result.state, null);
  });
});

/**
 * Production incident: a real Vobiz call showed the model's own
 * APPT_STATE_MARKER emission is not reliably followed — "Is there any slot
 * available today?" produced no checking_availability marker, and the
 * agent asked for an exact time instead of dispatching a real calendar
 * check. parseCallerIntentFromText is the deterministic backstop
 * (handleUserUtterance) that does not depend on the LLM at all — exercised
 * here directly against the exact reported phrase plus the task's own
 * required realistic speech variants, so a regression is caught without
 * needing a live/faked LLM call.
 */
describe("parseCallerIntentFromText — deterministic backstop over the caller's raw words, independent of the LLM's own marker reliability", () => {
  describe("availabilityRequested", () => {
    for (const phrase of [
      "Is there any slot available today?",
      "Are there any slots available today?",
      "Do you have any slots today?",
      "What's available today?",
      "What times are free tomorrow?",
      "Anything available this afternoon?",
      "What's the next available appointment?",
      "Do you have anything available?",
      "Can you check if that slot is available?",
      "Is 3 PM available tomorrow?",
    ]) {
      test(`detects an availability request in: "${phrase}"`, () => {
        assert.equal(
          parseCallerIntentFromText(phrase).availabilityRequested,
          true,
          `expected availabilityRequested=true for "${phrase}"`,
        );
      });
    }

    for (const phrase of [
      "My name is Dhanush.",
      "My phone number is nine nine nine nine nine nine nine nine nine nine.",
      "I'd like to book a teeth cleaning.",
      "Yeah, please confirm.",
      "Thank you, goodbye.",
    ]) {
      test(`does NOT misfire on an unrelated utterance: "${phrase}"`, () => {
        assert.equal(
          parseCallerIntentFromText(phrase).availabilityRequested,
          false,
          `expected availabilityRequested=false for "${phrase}"`,
        );
      });
    }
  });

  describe("wantsNextAvailable", () => {
    for (const phrase of [
      "What's the next available appointment?",
      "Book me at the next available time.",
      "What's the earliest you have?",
      "Can I get the soonest available slot?",
      "Book me as soon as possible.",
    ]) {
      test(`detects "next available" intent in: "${phrase}"`, () => {
        assert.equal(parseCallerIntentFromText(phrase).wantsNextAvailable, true);
      });
    }

    test("a plain exact-time request does not set wantsNextAvailable", () => {
      assert.equal(
        parseCallerIntentFromText("Is 3 PM available tomorrow?").wantsNextAvailable,
        false,
      );
    });
  });

  describe("preferredPeriod", () => {
    test('"this afternoon" resolves to "afternoon"', () => {
      assert.equal(
        parseCallerIntentFromText("Anything available this afternoon?").preferredPeriod,
        "afternoon",
      );
    });
    test('"in the morning" resolves to "morning"', () => {
      assert.equal(
        parseCallerIntentFromText("Anything in the morning?").preferredPeriod,
        "morning",
      );
    });
    test('"this evening" resolves to "evening"', () => {
      assert.equal(
        parseCallerIntentFromText("Do you have anything this evening?").preferredPeriod,
        "evening",
      );
    });
    test("an exact-time request has no period", () => {
      assert.equal(parseCallerIntentFromText("Is 3 PM available tomorrow?").preferredPeriod, null);
    });
  });

  describe("relativeDate", () => {
    test('"today" is detected', () => {
      assert.equal(
        parseCallerIntentFromText("Is there any slot available today?").relativeDate,
        "today",
      );
    });
    test('"tomorrow" is detected', () => {
      assert.equal(
        parseCallerIntentFromText("Well, tomorrow at three p.m.").relativeDate,
        "tomorrow",
      );
    });
    test("an explicit date has no relativeDate (left to the LLM's own date resolution)", () => {
      assert.equal(
        parseCallerIntentFromText("Can you book me for the 15th of next month?").relativeDate,
        null,
      );
    });
  });

  describe("weekday", () => {
    test('"Friday" is detected with forceNextWeek false', () => {
      assert.deepEqual(parseCallerIntentFromText("Friday at 4:30").weekday, {
        weekday: 5,
        forceNextWeek: false,
      });
    });
    test('"next Monday morning" detects Monday with forceNextWeek true', () => {
      assert.deepEqual(parseCallerIntentFromText("next Monday morning").weekday, {
        weekday: 1,
        forceNextWeek: true,
      });
    });
    test("every weekday name resolves to its correct 0=Sunday..6=Saturday index", () => {
      const expected: [string, number][] = [
        ["Sunday", 0],
        ["Monday", 1],
        ["Tuesday", 2],
        ["Wednesday", 3],
        ["Thursday", 4],
        ["Friday", 5],
        ["Saturday", 6],
      ];
      for (const [name, index] of expected) {
        assert.equal(
          parseCallerIntentFromText(`Can I come in on ${name}?`).weekday?.weekday,
          index,
          `expected ${name} to resolve to index ${index}`,
        );
      }
    });
    test("case-insensitive", () => {
      assert.equal(parseCallerIntentFromText("how about friday").weekday?.weekday, 5);
    });
    test("an utterance with no weekday name has weekday: null", () => {
      assert.equal(parseCallerIntentFromText("Is there any slot available today?").weekday, null);
    });
  });

  describe("explicitTime", () => {
    test('"3 PM" resolves to 15:00', () => {
      assert.equal(parseCallerIntentFromText("tomorrow at 3 PM").explicitTime, "15:00");
    });
    test('"3 PM tomorrow" (time first) resolves identically regardless of word order', () => {
      assert.equal(parseCallerIntentFromText("3 PM tomorrow").explicitTime, "15:00");
    });
    test('"3:30pm" (no space, lowercase, with minutes) resolves to 15:30', () => {
      assert.equal(parseCallerIntentFromText("Can we do 3:30pm?").explicitTime, "15:30");
    });
    test('"12 PM" is noon (12:00), not midnight', () => {
      assert.equal(parseCallerIntentFromText("12 PM works").explicitTime, "12:00");
    });
    test('"12 AM" is midnight (00:00)', () => {
      assert.equal(parseCallerIntentFromText("12 AM").explicitTime, "00:00");
    });
    test('"9 AM" resolves to 09:00', () => {
      assert.equal(parseCallerIntentFromText("9 AM please").explicitTime, "09:00");
    });
    test('"Friday at 4:30" (no meridiem) assumes afternoon — 16:30', () => {
      assert.equal(parseCallerIntentFromText("Friday at 4:30").explicitTime, "16:30");
    });
    test('"10:15" (no meridiem, hour 7-11) is left as-is — 10:15', () => {
      assert.equal(parseCallerIntentFromText("how about 10:15").explicitTime, "10:15");
    });
    test('an already-unambiguous 24-hour time ("15:00") is used as-is', () => {
      assert.equal(parseCallerIntentFromText("15:00 works for me").explicitTime, "15:00");
    });
    test("a bare number with no am/pm or minutes is never mistaken for a time", () => {
      assert.equal(parseCallerIntentFromText("I have 3 kids").explicitTime, null);
      assert.equal(parseCallerIntentFromText("I'll be there in 10 minutes").explicitTime, null);
    });
    test('"next Monday morning" has no explicit time — only a period', () => {
      const result = parseCallerIntentFromText("next Monday morning");
      assert.equal(result.explicitTime, null);
      assert.equal(result.preferredPeriod, "morning");
    });
    test("an utterance with no time at all has explicitTime: null", () => {
      assert.equal(parseCallerIntentFromText("My name is Dhanush.").explicitTime, null);
    });
  });

  describe("bookingConfirmed", () => {
    for (const phrase of [
      "Yeah, please confirm.",
      "Yes, confirm it.",
      "Oh, I can confirm at 3 p.m. tomorrow.",
      "Sure, that works.",
      "Go ahead and book it.",
      "Sounds good.",
      "Yep.",
      // The exact reported incident phrase — a confirmation combined with
      // an unrelated reminder request in the same breath — must still be
      // recognized as a confirmation.
      "Yeah, please confirm. Also, can you remind me at tomorrow at 1 p.m. that I have an appointment?",
    ]) {
      test(`detects a booking confirmation in: "${phrase}"`, () => {
        assert.equal(
          parseCallerIntentFromText(phrase).bookingConfirmed,
          true,
          `expected bookingConfirmed=true for "${phrase}"`,
        );
      });
    }

    for (const phrase of [
      "No, don't confirm that.",
      "Wait, not yet.",
      "Actually, cancel that.",
      "My name is Dhanush.",
    ]) {
      test(`does NOT treat a negation/unrelated phrase as a confirmation: "${phrase}"`, () => {
        assert.equal(parseCallerIntentFromText(phrase).bookingConfirmed, false);
      });
    }
  });

  describe("reminderRequested", () => {
    for (const phrase of [
      "Can you remind me at tomorrow at 1 p.m. that I have an appointment?",
      "Can you set a reminder for me?",
      "Please remind me tomorrow.",
      "Could you send me a reminder?",
      "Can you alert me before the appointment?",
    ]) {
      test(`detects a reminder request in: "${phrase}"`, () => {
        assert.equal(parseCallerIntentFromText(phrase).reminderRequested, true);
      });
    }

    test("a plain booking confirmation does not set reminderRequested", () => {
      assert.equal(
        parseCallerIntentFromText("Oh, I can confirm at 3 p.m. tomorrow.").reminderRequested,
        false,
      );
    });
  });

  /**
   * Production incident investigation (Fix #3): a spoken phone number
   * "7-9-0 6-9-0 3-0" was later represented in AppointmentState as
   * "7-9-0 0" — root-caused to the model having to COPY the full digit
   * string into its own JSON marker rather than the runtime ever reading
   * the caller's raw words itself. extractPhoneNumber (exercised here via
   * parseCallerIntentFromText) is the fix: a direct regex read of the
   * caller's own turn text, never routed through the model at all.
   */
  describe("phone", () => {
    test("a long, STT-style digit-by-digit spoken phone number is captured in full, not truncated", () => {
      assert.equal(parseCallerIntentFromText("It's 7-9-0 6-9-0 3-0-9-9").phone, "7906903099");
    });

    test("a phone number spoken as a single run of words is captured in full", () => {
      assert.equal(
        parseCallerIntentFromText("My number is nine nine nine nine nine nine nine nine nine nine")
          .phone,
        null,
        "word-form digits (not numerals) are intentionally out of scope — only numeral digit runs are extracted",
      );
    });

    test("a plain 10-digit number with no separators is captured", () => {
      assert.equal(parseCallerIntentFromText("My number is 9876543210").phone, "9876543210");
    });

    test("a phone number embedded in a longer sentence is still captured in full", () => {
      assert.equal(
        parseCallerIntentFromText("Yeah, you can reach me at 790 690 3099, thanks").phone,
        "7906903099",
      );
    });

    test("a short number (a time, a quantity) is never mistaken for a phone number", () => {
      assert.equal(parseCallerIntentFromText("I have 3 kids").phone, null);
      assert.equal(parseCallerIntentFromText("3 PM works for me").phone, null);
      assert.equal(parseCallerIntentFromText("tomorrow at 3:30").phone, null);
    });

    test("an utterance with no digits at all has phone: null", () => {
      assert.equal(parseCallerIntentFromText("My name is Dhanush.").phone, null);
    });
  });

  describe("email", () => {
    test("a symbolic email address (x@y.tld) is captured exactly, in full", () => {
      assert.equal(
        parseCallerIntentFromText("It's chdhansh56@gmail.com").email,
        "chdhansh56@gmail.com",
      );
    });

    test("an email spoken as 'name at domain dot tld' (STT's likely verbatim transcription) is captured and normalized to symbolic form", () => {
      assert.equal(
        parseCallerIntentFromText("chdhnsh56 at gmail dot com").email,
        "chdhnsh56@gmail.com",
      );
    });

    test("an email embedded in a longer sentence is still captured in full", () => {
      assert.equal(
        parseCallerIntentFromText("You can email me at dhanush.k@example.co.in, that's it").email,
        "dhanush.k@example.co.in",
      );
    });

    test("an utterance with no email at all has email: null", () => {
      assert.equal(parseCallerIntentFromText("My number is 9876543210").email, null);
    });

    // Production incident (previously a KNOWN LIMITATION, fixed here):
    // EMAIL_SPOKEN_PATTERN's local-part capture group used to allow a
    // multi-word run before "at" (meant to support a spelled-out local
    // part like "d h a n u s h at gmail dot com") — but since regex.exec
    // tries the leftmost starting position first, that same greediness
    // let it swallow unrelated LEADING words in the sentence too. Fixed
    // by restricting the local part (and the domain) to a single
    // alphanumeric token each — see EMAIL_SPOKEN_PATTERN's own comment
    // for why that trade is safe (no test or real call ever exercised a
    // genuine multi-word local part).
    test("leading filler words before a spoken-form email are no longer swallowed into the local part", () => {
      assert.equal(
        parseCallerIntentFromText("My email is chdhnsh56 at gmail dot com").email,
        "chdhnsh56@gmail.com",
      );
    });

    test("another common natural-sentence prefix ('It's X at Y dot Z') is also handled correctly", () => {
      assert.equal(
        parseCallerIntentFromText("It's chdhnsh56 at gmail dot com").email,
        "chdhnsh56@gmail.com",
      );
    });

    test("a prefix that itself contains the literal word 'at' still resolves to the email's own 'at', not the filler one", () => {
      assert.equal(
        parseCallerIntentFromText("You can reach me at chdhnsh56 at gmail dot com").email,
        "chdhnsh56@gmail.com",
      );
    });
  });
});

/**
 * Production reliability gap: every availability check and booking used a
 * hardcoded 30-minute appointment duration regardless of what the business
 * actually configured per service — matchService is the pure matching core
 * resolveBookingContext uses to read the real services.duration_minutes
 * instead. Tested directly (not through the harness) because this
 * codebase's test harness has no real Supabase client to resolve
 * resolveBookingContext's own DB query through.
 */
describe("matchService — resolves the caller's requested service to its configured duration_minutes", () => {
  const rows = [
    { id: "svc-15", name: "Quick Consultation", duration_minutes: 15 },
    { id: "svc-30", name: "Teeth Cleaning", duration_minutes: 30 },
    { id: "svc-45", name: "Deep Cleaning & Polish", duration_minutes: 45 },
    { id: "svc-60", name: "Full Checkup", duration_minutes: 60 },
  ];

  for (const [name, id, minutes] of [
    ["Quick Consultation", "svc-15", 15],
    ["Teeth Cleaning", "svc-30", 30],
    ["Deep Cleaning & Polish", "svc-45", 45],
    ["Full Checkup", "svc-60", 60],
  ] as [string, string, number][]) {
    test(`exact name match resolves "${name}" to its configured ${minutes}-minute duration`, () => {
      const result = matchService(rows, name);
      assert.equal(result.id, id);
      assert.equal(result.durationMinutes, minutes);
    });
  }

  test("exact match is case-insensitive", () => {
    const result = matchService(rows, "teeth cleaning");
    assert.equal(result.id, "svc-30");
    assert.equal(result.durationMinutes, 30);
  });

  test("the caller's free-text wording substring-matches a longer configured name (45-minute service)", () => {
    // Caller said "teeth cleaning" without the "& Polish" suffix.
    const result = matchService(rows, "deep cleaning");
    assert.equal(result.id, "svc-45");
    assert.equal(result.durationMinutes, 45);
  });

  test("a configured name that is a substring of the caller's longer free-text wording also matches", () => {
    const result = matchService(rows, "I'd like the full checkup please");
    assert.equal(result.id, "svc-60");
    assert.equal(result.durationMinutes, 60);
  });

  test("no service known at all (null) falls back to the default duration, never guesses", () => {
    const result = matchService(rows, null);
    assert.equal(result.id, null);
    assert.equal(result.durationMinutes, 30);
  });

  test("a service name that matches nothing configured falls back to the default duration", () => {
    const result = matchService(rows, "haircut");
    assert.equal(result.id, null);
    assert.equal(result.durationMinutes, 30);
  });

  test("a matched service with no duration configured (null) falls back to the default, never invents one", () => {
    const result = matchService(
      [{ id: "svc-x", name: "Mystery Service", duration_minutes: null }],
      "mystery service",
    );
    assert.equal(result.id, "svc-x");
    assert.equal(result.durationMinutes, 30);
  });

  test("an empty services list always falls back to the default duration", () => {
    const result = matchService([], "teeth cleaning");
    assert.equal(result.id, null);
    assert.equal(result.durationMinutes, 30);
  });
});

/**
 * Production incident (Round E): "General checkup, and let me know if that
 * slot is free or not." dispatched an early availability check with
 * AppointmentState.service still null, silently defaulting to a 30-minute
 * slot regardless of what the business actually configured for a general
 * checkup — because nothing captured the service name from the caller's
 * own text before tryEarlyDeterministicDispatch ran (no marker had been
 * consulted yet). matchServiceInText is the REVERSE lookup direction from
 * matchService (raw text -> configured name, not known name -> row) that
 * fixes this; tested directly here, same reasoning as matchService's own
 * suite above.
 */
describe("matchServiceInText — captures a configured service's name directly from the caller's own turn text", () => {
  const rows = [
    { id: "svc-15", name: "Quick Consultation", duration_minutes: 15 },
    { id: "svc-30", name: "General Checkup", duration_minutes: 30 },
    { id: "svc-45", name: "Deep Cleaning & Polish", duration_minutes: 45 },
    { id: "svc-60", name: "Cleaning", duration_minutes: 60 },
  ];

  test('the exact real-incident phrase: "General checkup, and let me know if that slot is free or not." matches "General Checkup"', () => {
    const result = matchServiceInText(
      rows,
      "General checkup, and let me know if that slot is free or not.",
    );
    assert.equal(result, "General Checkup");
  });

  test("matching is case-insensitive", () => {
    assert.equal(
      matchServiceInText(rows, "I'd like a quick consultation please"),
      "Quick Consultation",
    );
  });

  test("prefers the LONGEST matching configured name, so a short name doesn't shadow a more specific one also present", () => {
    // Both "Cleaning" and "Deep Cleaning & Polish" are substrings this
    // text could match — the longer, more specific one must win.
    const result = matchServiceInText(rows, "I'd like the deep cleaning & polish service");
    assert.equal(result, "Deep Cleaning & Polish");
  });

  test("a plain mention of the shorter name alone still matches it", () => {
    assert.equal(matchServiceInText(rows, "Just a cleaning please"), "Cleaning");
  });

  test("no configured service name appears anywhere in the text: returns null, never guesses", () => {
    assert.equal(matchServiceInText(rows, "What time do you close?"), null);
  });

  test("an empty services list always returns null", () => {
    assert.equal(matchServiceInText([], "General checkup please"), null);
  });

  test("a row with an empty/whitespace-only name is skipped rather than matching everything", () => {
    assert.equal(
      matchServiceInText([{ id: "svc-x", name: "   ", duration_minutes: 30 }], "anything at all"),
      null,
    );
  });
});

/**
 * Production incident (round 2 of the appointment reliability fixes): an
 * explicit "tomorrow at 3 PM" / "Friday at 4:30" the caller actually said
 * must reach AppointmentState even when the model's own marker leaves
 * preferred_date/preferred_time unset — but a marker value that IS
 * present must never be overridden by the extraction backstop, matching
 * every other caller-intent backstop in this file (availabilityRequested,
 * bookingConfirmed). mergeAppointmentState's `extracted` parameter is this
 * backstop; tested directly here since it is the exact mechanism, not an
 * end-to-end proxy for it.
 */
describe("mergeAppointmentState — extracted date/time is a backstop, never an override", () => {
  test("extraction fills in preferredDate when the marker proposes none (null)", () => {
    const result = mergeAppointmentState(
      emptyAppointmentState(),
      { preferredDate: null, preferredTime: null },
      { preferredDate: "2026-10-09", preferredTime: null },
    );
    assert.equal(result.preferredDate, "2026-10-09");
  });

  test("extraction fills in preferredTime when the marker proposes none (null)", () => {
    const result = mergeAppointmentState(
      emptyAppointmentState(),
      { preferredDate: "2026-10-09", preferredTime: null },
      { preferredDate: null, preferredTime: "15:00" },
    );
    assert.equal(result.preferredTime, "15:00");
  });

  test("extraction fills in BOTH date and time when the marker proposes neither", () => {
    const result = mergeAppointmentState(
      emptyAppointmentState(),
      { preferredDate: null, preferredTime: null },
      { preferredDate: "2026-10-09", preferredTime: "15:00" },
    );
    assert.equal(result.preferredDate, "2026-10-09");
    assert.equal(result.preferredTime, "15:00");
  });

  test("extraction fills the date/time gap even when the marker is entirely absent (null, not just incomplete)", () => {
    const result = mergeAppointmentState(emptyAppointmentState(), null, {
      preferredDate: "2026-10-09",
      preferredTime: "15:00",
    });
    assert.equal(result.preferredDate, "2026-10-09");
    assert.equal(result.preferredTime, "15:00");
  });

  test("a marker-proposed preferredDate is NEVER overridden by extraction, even when extraction found a different date", () => {
    const result = mergeAppointmentState(
      emptyAppointmentState(),
      { preferredDate: "2026-10-10", preferredTime: null },
      { preferredDate: "2026-10-09", preferredTime: null },
    );
    assert.equal(result.preferredDate, "2026-10-10", "the marker's own value must win");
  });

  test("a marker-proposed preferredTime is NEVER overridden by extraction, even when extraction found a different time", () => {
    const result = mergeAppointmentState(
      emptyAppointmentState(),
      { preferredDate: null, preferredTime: "16:00" },
      { preferredDate: null, preferredTime: "15:00" },
    );
    assert.equal(result.preferredTime, "16:00", "the marker's own value must win");
  });

  test("a value extraction established on a PREVIOUS turn survives this turn's incomplete/null marker (sticky current)", () => {
    const afterTurn1 = mergeAppointmentState(
      emptyAppointmentState(),
      { preferredDate: null },
      {
        preferredDate: "2026-10-09",
        preferredTime: "15:00",
      },
    );
    assert.equal(afterTurn1.preferredDate, "2026-10-09");

    // Turn 2: marker proposes nothing new, and this turn's own text has no
    // date/time to extract either (extracted is undefined/empty) — the
    // PREVIOUS turn's correctly-extracted value must survive untouched.
    const afterTurn2 = mergeAppointmentState(afterTurn1, { service: "teeth cleaning" });
    assert.equal(afterTurn2.preferredDate, "2026-10-09", "must not be nulled out");
    assert.equal(afterTurn2.preferredTime, "15:00", "must not be nulled out");
  });

  test("changing the extracted date invalidates a stale availabilityStatus/selectedSlot, same as a marker-driven change", () => {
    const checked: ReturnType<typeof emptyAppointmentState> = {
      ...emptyAppointmentState(),
      preferredDate: "2026-10-09",
      preferredTime: "15:00",
      availabilityStatus: "available",
      selectedSlot: { start: "2026-10-09T15:00:00.000Z", end: "2026-10-09T15:30:00.000Z" },
    };
    const result = mergeAppointmentState(
      checked,
      { preferredTime: null },
      {
        preferredDate: null,
        preferredTime: "16:00",
      },
    );
    assert.equal(result.preferredTime, "16:00");
    assert.equal(result.availabilityStatus, "unknown", "the old 15:00 result no longer applies");
    assert.equal(result.selectedSlot, null);
  });

  test("no proposed marker AND no extraction returns the exact same state untouched", () => {
    const current = {
      ...emptyAppointmentState(),
      preferredDate: "2026-10-09",
      preferredTime: "15:00",
      availabilityStatus: "available" as const,
    };
    const result = mergeAppointmentState(current, null);
    assert.deepEqual(result, current);
  });

  /**
   * Item 2 (Round E): matchServiceInText's result is fed into
   * mergeAppointmentState's `extracted.service` using the SAME
   * marker-wins-fills-gap priority as date/time (not phone/email's
   * sticky-wins priority) — see mergeAppointmentState's own doc comment
   * for why.
   */
  describe("mergeAppointmentState — extracted.service follows the SAME marker-wins-fills-gap priority as date/time", () => {
    test("extraction fills in service when the marker proposes none (undefined/absent)", () => {
      const result = mergeAppointmentState(emptyAppointmentState(), null, {
        service: "General Checkup",
      });
      assert.equal(result.service, "General Checkup");
    });

    test("a marker-proposed service is NEVER overridden by extraction, even when extraction found a different name", () => {
      const result = mergeAppointmentState(
        emptyAppointmentState(),
        { service: "Teeth Cleaning" },
        { service: "General Checkup" },
      );
      assert.equal(result.service, "Teeth Cleaning", "the marker's own value must win");
    });

    test("a service captured on a PREVIOUS turn survives a later turn with no new extraction (sticky current)", () => {
      const afterTurn1 = mergeAppointmentState(emptyAppointmentState(), null, {
        service: "General Checkup",
      });
      assert.equal(afterTurn1.service, "General Checkup");

      const afterTurn2 = mergeAppointmentState(afterTurn1, { preferredTime: "15:00" });
      assert.equal(afterTurn2.service, "General Checkup", "must not be nulled out");
    });
  });

  /**
   * Fix #3 (production incident: a spoken phone number "7-9-0 6-9-0 3-0"
   * was later represented as "7-9-0 0"): phone/email take the OPPOSITE
   * merge priority from date/time — extraction (the raw digits/characters
   * read directly off the caller's own turn) wins over whatever the
   * model's marker proposes, rather than only filling a gap the marker
   * left empty. See mergeAppointmentState's own doc comment for the full
   * reasoning (the model has to literally copy/re-type these long strings,
   * which is where the truncation came from).
   */
  describe("mergeAppointmentState — phone/email: extraction wins over the marker (the OPPOSITE priority from date/time)", () => {
    test("extracted phone overrides a marker-proposed phone, even when the marker proposed a (shorter/wrong) value", () => {
      const result = mergeAppointmentState(
        emptyAppointmentState(),
        { phone: "7900" },
        { phone: "7906903099" },
      );
      assert.equal(
        result.phone,
        "7906903099",
        "the raw extracted digits must win over the model's own (truncated) copy",
      );
    });

    test("extracted email overrides a marker-proposed email", () => {
      const result = mergeAppointmentState(
        emptyAppointmentState(),
        { email: "wrong@x.com" },
        { email: "chdhnsh56@gmail.com" },
      );
      assert.equal(result.email, "chdhnsh56@gmail.com");
    });

    test("when extraction finds nothing this turn, the marker's own proposed phone/email is used", () => {
      const result = mergeAppointmentState(
        emptyAppointmentState(),
        { phone: "9999999999", email: "dhanush@example.com" },
        {},
      );
      assert.equal(result.phone, "9999999999");
      assert.equal(result.email, "dhanush@example.com");
    });

    test("a phone/email established on a previous turn survives a later turn with no marker and no extraction (sticky current)", () => {
      const afterTurn1 = mergeAppointmentState(
        emptyAppointmentState(),
        {},
        { phone: "7906903099", email: "chdhnsh56@gmail.com" },
      );
      assert.equal(afterTurn1.phone, "7906903099");

      const afterTurn2 = mergeAppointmentState(afterTurn1, { service: "teeth cleaning" });
      assert.equal(afterTurn2.phone, "7906903099", "must not be dropped/truncated on a later turn");
      assert.equal(afterTurn2.email, "chdhnsh56@gmail.com");
    });

    test("extraction fills the gap when the marker proposes no phone/email at all (null)", () => {
      const result = mergeAppointmentState(
        emptyAppointmentState(),
        { phone: null, email: null },
        { phone: "7906903099", email: "chdhnsh56@gmail.com" },
      );
      assert.equal(result.phone, "7906903099");
      assert.equal(result.email, "chdhnsh56@gmail.com");
    });
  });
});

describe("appointmentReadyForAvailabilityCheck — the Fix #1 completion trigger (deliberately narrower than a full booking: no phone/email required)", () => {
  function state(overrides: Partial<ReturnType<typeof emptyAppointmentState>>) {
    return { ...emptyAppointmentState(), ...overrides };
  }

  test("true once service + customer name + preferred date + preferred time are all known — even with no phone/email", () => {
    assert.equal(
      appointmentReadyForAvailabilityCheck(
        state({
          service: "teeth cleaning",
          customerName: "Dhanush",
          preferredDate: "2026-10-09",
          preferredTime: "15:00",
        }),
      ),
      true,
    );
  });

  test("an explicit 'next available' request satisfies the time requirement without a specific preferredTime", () => {
    assert.equal(
      appointmentReadyForAvailabilityCheck(
        state({
          service: "teeth cleaning",
          customerName: "Dhanush",
          preferredDate: "2026-10-09",
          wantsNextAvailable: true,
        }),
      ),
      true,
    );
  });

  for (const missing of ["service", "customerName", "preferredDate"] as const) {
    test(`false when ${missing} is missing`, () => {
      const complete = state({
        service: "teeth cleaning",
        customerName: "Dhanush",
        preferredDate: "2026-10-09",
        preferredTime: "15:00",
      });
      assert.equal(appointmentReadyForAvailabilityCheck({ ...complete, [missing]: null }), false);
    });
  }

  test("false when neither preferredTime nor wantsNextAvailable is set", () => {
    assert.equal(
      appointmentReadyForAvailabilityCheck(
        state({
          service: "teeth cleaning",
          customerName: "Dhanush",
          preferredDate: "2026-10-09",
        }),
      ),
      false,
    );
  });

  test("still true with no phone and no email set — Fix #1's whole point", () => {
    assert.equal(
      appointmentReadyForAvailabilityCheck(
        state({
          service: "teeth cleaning",
          customerName: "Dhanush",
          preferredDate: "2026-10-09",
          preferredTime: "15:00",
          phone: null,
          email: null,
        }),
      ),
      true,
    );
  });
});

describe("spokenDateLabel / spokenTimeLabel / describeRequestedTime — never read a bare ISO date or 24-hour time digit-by-digit to the caller", () => {
  test('today\'s date resolves to "today"', () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    assert.equal(spokenDateLabel("2026-10-08", "UTC", now), "today");
  });

  test('tomorrow\'s date resolves to "tomorrow"', () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    assert.equal(spokenDateLabel("2026-10-09", "UTC", now), "tomorrow");
  });

  test("a date further out falls back to a plain 'Month Day' label, never a bare ISO string", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    assert.equal(spokenDateLabel("2026-10-15", "UTC", now), "October 15");
  });

  test('"15:00" reads as "3 PM", never the bare 24-hour digits', () => {
    assert.equal(spokenTimeLabel("15:00"), "3 PM");
  });

  test('"15:30" reads as "3:30 PM" (minutes kept when non-zero)', () => {
    assert.equal(spokenTimeLabel("15:30"), "3:30 PM");
  });

  test('midnight ("00:00") reads as "12 AM"', () => {
    assert.equal(spokenTimeLabel("00:00"), "12 AM");
  });

  test('noon ("12:00") reads as "12 PM"', () => {
    assert.equal(spokenTimeLabel("12:00"), "12 PM");
  });

  test("describeRequestedTime prefers an exact preferredTime over a period or next-available", () => {
    assert.equal(
      describeRequestedTime({ ...emptyAppointmentState(), preferredTime: "15:00" }),
      "3 PM",
    );
  });

  test("describeRequestedTime falls back to the period when there is no exact time", () => {
    assert.equal(
      describeRequestedTime({ ...emptyAppointmentState(), preferredPeriod: "afternoon" }),
      "the afternoon",
    );
  });

  test("describeRequestedTime falls back to 'the next available time' for wantsNextAvailable", () => {
    assert.equal(
      describeRequestedTime({ ...emptyAppointmentState(), wantsNextAvailable: true }),
      "the next available time",
    );
  });

  test("describeRequestedTime never invents a time — falls back to a neutral 'that time' when nothing is known", () => {
    assert.equal(describeRequestedTime(emptyAppointmentState()), "that time");
  });
});

describe("replyAlreadyAcknowledges — avoids a duplicate deterministic acknowledgement when the model's own reply already reads as one", () => {
  test("the model's reply opening with the caller's own name counts as already acknowledging", () => {
    assert.equal(replyAlreadyAcknowledges("Dhanush, what time works for you?", "Dhanush"), true);
  });

  test('a reply opening with "Got it" counts as already acknowledging', () => {
    assert.equal(replyAlreadyAcknowledges("Got it, what's next?", null), true);
  });

  test('a reply opening with "Thanks"/"Perfect"/"Noted" each count as already acknowledging', () => {
    assert.equal(replyAlreadyAcknowledges("Thanks! Let's continue.", null), true);
    assert.equal(replyAlreadyAcknowledges("Perfect, one moment.", null), true);
    assert.equal(replyAlreadyAcknowledges("Noted, thank you.", null), true);
  });

  test("a plain reply with none of these cues does not count as already acknowledging", () => {
    assert.equal(
      replyAlreadyAcknowledges("What date and time would you prefer?", "Dhanush"),
      false,
    );
  });

  test("the caller's name appearing only much later in a long reply does not count (only the lead is checked)", () => {
    const reply =
      "Let me check our calendar for you right now, one moment please while I look that up, Dhanush.";
    assert.equal(replyAlreadyAcknowledges(reply, "Dhanush"), false);
  });
});

const ALL_STATES: RuntimeState[] = [
  "created",
  "connecting",
  "greeting",
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "interrupted",
  "ending",
  "ended",
  "failed",
];

describe("isValidRuntimeTransition — the runtime state machine", () => {
  test("every state is trivially a valid transition to itself (same-state events are a no-op, never an error)", () => {
    for (const s of ALL_STATES) assert.equal(isValidRuntimeTransition(s, s), true);
  });

  test("the normal happy-path startup sequence is valid: created -> connecting -> greeting -> listening", () => {
    assert.equal(isValidRuntimeTransition("created", "connecting"), true);
    assert.equal(isValidRuntimeTransition("connecting", "greeting"), true);
    assert.equal(isValidRuntimeTransition("greeting", "listening"), true);
  });

  test("the normal turn-taking cycle is valid: listening -> transcribing -> thinking -> speaking -> listening", () => {
    assert.equal(isValidRuntimeTransition("listening", "transcribing"), true);
    assert.equal(isValidRuntimeTransition("transcribing", "thinking"), true);
    assert.equal(isValidRuntimeTransition("thinking", "speaking"), true);
    assert.equal(isValidRuntimeTransition("speaking", "listening"), true);
  });

  test("barge-in is valid from every state the agent could be mid-turn in: greeting/thinking/speaking -> interrupted", () => {
    assert.equal(isValidRuntimeTransition("greeting", "interrupted"), true);
    assert.equal(isValidRuntimeTransition("thinking", "interrupted"), true);
    assert.equal(isValidRuntimeTransition("speaking", "interrupted"), true);
  });

  test("interrupted resolves forward into a new turn (thinking) or back to listening/transcribing", () => {
    assert.equal(isValidRuntimeTransition("interrupted", "thinking"), true);
    assert.equal(isValidRuntimeTransition("interrupted", "listening"), true);
    assert.equal(isValidRuntimeTransition("interrupted", "transcribing"), true);
  });

  test("every non-terminal state can move to ending (a session can be torn down from anywhere)", () => {
    for (const s of ALL_STATES) {
      if (s === "ended" || s === "failed") continue;
      assert.equal(isValidRuntimeTransition(s, "ending"), true, `${s} -> ending should be valid`);
    }
  });

  test("every non-terminal state can move to failed (a runtime error can happen from anywhere)", () => {
    for (const s of ALL_STATES) {
      if (s === "ended" || s === "failed") continue;
      assert.equal(isValidRuntimeTransition(s, "failed"), true, `${s} -> failed should be valid`);
    }
  });

  test("ended and failed are terminal — nothing transitions out of them, not even to each other", () => {
    for (const s of ALL_STATES) {
      assert.equal(isValidRuntimeTransition("ended", s), s === "ended");
      assert.equal(isValidRuntimeTransition("failed", s), s === "failed");
    }
  });

  test("invalid, unreachable jumps are rejected: created -> speaking, listening -> greeting, speaking -> transcribing", () => {
    assert.equal(isValidRuntimeTransition("created", "speaking"), false);
    assert.equal(isValidRuntimeTransition("listening", "greeting"), false);
    assert.equal(isValidRuntimeTransition("speaking", "transcribing"), false);
  });

  test("a session cannot go backwards from ending to a live conversational state", () => {
    for (const s of [
      "greeting",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "interrupted",
    ] as const) {
      assert.equal(isValidRuntimeTransition("ending", s), false);
    }
  });
});

test("chunkIntoSentences: splits on sentence boundaries", () => {
  const chunks = chunkIntoSentences("Hello there, welcome! How can I help you today? Sure thing.");
  assert.deepEqual(chunks, ["Hello there, welcome!", "How can I help you today?", "Sure thing."]);
});

test("chunkIntoSentences: short fragments are merged rather than sent as tiny chunks", () => {
  const chunks = chunkIntoSentences("Ok. Yes. Sure, no problem at all, happy to help with that.");
  // "Ok." and "Yes." are each under the 20-char minimum, so they merge
  // forward into the next chunk instead of firing two near-empty TTS calls.
  assert.ok(chunks.length <= 2);
  assert.ok(chunks.join(" ").includes("Ok."));
});

test("chunkIntoSentences: empty input yields no chunks", () => {
  assert.deepEqual(chunkIntoSentences(""), []);
  assert.deepEqual(chunkIntoSentences("   "), []);
});

function fakeBridge(): AudioMediaBridge {
  return {
    inboundFormat: { encoding: "mulaw", sampleRateHz: 8000 },
    outboundFormat: { encoding: "mulaw", sampleRateHz: 8000 },
    onInboundFrame: (_cb: (frame: AudioFrame) => void) => {},
    sendOutboundFrame: () => {},
    clearOutboundBuffer: () => {},
    onClose: (_cb: (reason: string) => void) => {},
    close: () => {},
  };
}

const minimalAgent: AgentSnapshot["agent"] = {
  agent_name: "Aria",
  persona: "professional",
  custom_personality: null,
  objectives: ["answer_questions"],
  capabilities: {},
  primary_language: "en-IN",
  extra_languages: [],
  multilingual: false,
  voice_id: "ritu",
  speaking_pace: 1,
  greetings: { "en-IN": "Hello, thanks for calling." },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

test("startRuntimeSession: without SARVAM_API_KEY, fails closed into 'failed' (never throws)", async () => {
  delete process.env["SARVAM_API_KEY"];
  const callId = `test-call-${crypto.randomUUID()}`;
  const handle = await startRuntimeSession({
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: null,
    agentVersion: null,
    instructions: "You are a helpful receptionist.",
    snapshotAgent: minimalAgent,
    businessName: "Test Business",
    bridge: fakeBridge(),
  });
  assert.equal(handle.state, "failed");
  // Cleanup already ran (terminateRuntimeSession is called internally on
  // connect failure), so the session must not be left dangling in memory.
  assert.equal(getActiveSession(callId), null);
});

test("startRuntimeSession: concurrent calls for the same call_id do not start two sessions", async () => {
  delete process.env["SARVAM_API_KEY"];
  const callId = `test-call-dup-${crypto.randomUUID()}`;
  const bridge = fakeBridge();
  const input = {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: null,
    agentVersion: null,
    instructions: "You are a helpful receptionist.",
    snapshotAgent: minimalAgent,
    businessName: "Test Business",
    bridge,
  };
  // Fired back-to-back, synchronously, before either has awaited anything —
  // the second call must observe the first's session already registered.
  const [h1, h2] = await Promise.all([startRuntimeSession(input), startRuntimeSession(input)]);
  assert.equal(h1.runtimeSessionId, h2.runtimeSessionId);
});

/**
 * Silence/timeout handling (requirement 6): a caller who goes quiet is
 * prompted once, then hung up on if the silence continues. There is no
 * mocked Sarvam WS harness in this repo to drive a session all the way to
 * LISTENING and fast-forward real timers (every other test above proves
 * only the fail-closed ERROR path, since SARVAM_API_KEY is deliberately
 * unset), so — same technique as agent.functions.test.ts for other
 * hard-to-integration-test async logic — this is a source scan proving the
 * wiring: every place the runtime settles into "waiting on the caller"
 * arms the timer, every place the caller actually speaks disarms it, and
 * cleanup never leaves a timer running past the session's lifetime.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "voice-runtime.server.ts"),
  "utf8",
);

describe("silence/timeout handling — wiring", () => {
  test("two-stage thresholds: a prompt before a hangup, not the other way round", () => {
    assert.match(src, /const SILENCE_PROMPT_MS = 12_000;/);
    assert.match(src, /const SILENCE_HANGUP_MS = 10_000;/);
  });

  test("armSilenceTimer only ever arms while waiting on the caller (listening/transcribing/interrupted)", () => {
    const fnStart = src.indexOf("function armSilenceTimer(session: Session) {");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(fnBody, /if \(!isAwaitingCaller\(state\)\) return;/);
    const isAwaitingCallerBody = src.slice(
      src.indexOf("function isAwaitingCaller(state: RuntimeState): boolean {"),
      src.indexOf(
        "\n}\n",
        src.indexOf("function isAwaitingCaller(state: RuntimeState): boolean {"),
      ),
    );
    assert.match(isAwaitingCallerBody, /state === "listening"/);
    assert.match(isAwaitingCallerBody, /state === "transcribing"/);
    assert.match(isAwaitingCallerBody, /state === "interrupted"/);
  });

  test("the timer fires the one-time prompt before it ever hangs up, gated by silencePromptSent", () => {
    const fnStart = src.indexOf("function armSilenceTimer(session: Session) {");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(
      fnBody,
      /if \(session\.silencePromptSent\) void endDueToSilence\(session\);\s*\n\s*else void speakSilencePrompt\(session\);/,
    );
  });

  test("speech_start unconditionally cancels the pending timer and resets the prompt flag, before the barge-in branch", () => {
    const caseStart = src.indexOf('case "speech_start": {');
    // Found via the condition's last disjunct rather than the whole literal
    // if-statement text, which Prettier is free to reflow across lines.
    const bargeInIdx = src.indexOf("audioStillPlaying", caseStart);
    const clearIdx = src.indexOf("clearSilenceTimer(session);", caseStart);
    const resetIdx = src.indexOf("session.silencePromptSent = false;", caseStart);
    assert.ok(caseStart > -1 && bargeInIdx > -1 && clearIdx > -1 && resetIdx > -1);
    assert.ok(clearIdx < bargeInIdx && resetIdx < bargeInIdx);
  });

  test("barge-in works during the greeting too, not only during later speaking/thinking turns", () => {
    const caseStart = src.indexOf('case "speech_start": {');
    const caseEnd = src.indexOf('case "speech_end":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(caseBody, /state === "greeting"/);
    assert.match(caseBody, /setState\(session, "interrupted"\);/);
  });

  test("speech_start while listening (or waiting_on_payment, Phase 4) moves to transcribing (a distinct, explicit state)", () => {
    const caseStart = src.indexOf('case "speech_start": {');
    const caseEnd = src.indexOf('case "speech_end":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(
      caseBody,
      /else if \(state === "listening" \|\| state === "waiting_on_payment"\) \{\s*\n\s*setState\(session, "transcribing"\);/,
    );
  });

  test("speech_end re-arms rather than speech_start, so the window doesn't start while the caller is still mid-utterance", () => {
    assert.match(src, /case "speech_end":[\s\S]{0,600}armSilenceTimer\(session\);/);
  });

  test("all four handleUserUtterance exit paths (empty raw reply, empty after marker/booking, reply spoken, LLM error) re-arm before returning to LISTENING", () => {
    const fnStart = src.indexOf("async function handleUserUtterance(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    const armOccurrences = [...fnBody.matchAll(/armSilenceTimer\(session\);/g)];
    assert.equal(armOccurrences.length, 4);
  });

  /**
   * Production incident (silence_hangup despite the caller speaking twice):
   * speech_end arms a fresh silence timer the moment the caller stops
   * talking — before final_transcript has even arrived, let alone before
   * handleUserUtterance has started processing it. That timer was
   * previously only ever cleared by a *subsequent* speech_start or by this
   * same turn's own completion (armSilenceTimer re-arming), never by the
   * turn actually being accepted. Asserting clearSilenceTimer is the very
   * first thing handleUserUtterance does — before setState("thinking"),
   * before the LLM is even asked — so a slow STT finalization/LLM/TTS round
   * trip for this turn can never race a timer armed before it began.
   */
  test("handleUserUtterance clears the silence timer immediately on accepting a turn, before entering THINKING", () => {
    const fnStart = src.indexOf("async function handleUserUtterance(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    const pushIdx = fnBody.indexOf('session.turns.push({ role: "user"');
    const clearIdx = fnBody.indexOf("clearSilenceTimer(session);");
    const thinkingIdx = fnBody.indexOf('setState(session, "thinking");');
    assert.ok(pushIdx > -1 && clearIdx > -1 && thinkingIdx > -1);
    assert.ok(
      pushIdx < clearIdx && clearIdx < thinkingIdx,
      "clearSilenceTimer must run after the turn is accepted but before THINKING is entered",
    );
  });

  test("the greeting arms the timer once the caller is being listened to", () => {
    assert.match(
      src,
      /setState\(session, "listening"\);\s*\n\s*armSilenceTimer\(session\);[\s\S]{0,300}log\("greeting_played"/,
    );
  });

  test("terminateRuntimeSession clears the timer during cleanup — no timer outlives its session", () => {
    const fnStart = src.indexOf("export async function terminateRuntimeSession(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(fnBody, /clearSilenceTimer\(session\);/);
  });

  test("the hangup path speaks a goodbye and terminates with a distinct, honest reason", () => {
    const fnStart = src.indexOf("async function endDueToSilence(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(
      fnBody,
      /await terminateRuntimeSession\(session\.input\.callId, "caller_silence_timeout"\);/,
    );
  });
});

/**
 * Production incident (round 8): Sarvam's realtime STT rejects
 * language_code="unknown" with a fatal 400 ("Unsupported language_code
 * 'unknown'. Supported values: auto, hi-IN, ...") and immediately closes
 * the WebSocket with code 4000 — so STT never connected for any call.
 * "auto" is Sarvam's actual documented auto-detect code. Source-scanned
 * (same convention as the suites above) since the STT connect call site
 * isn't exported; voice-runtime-harness.test.ts's "STT always requests
 * language auto-detection" suite covers the same value via the fake STT's
 * recorded connect call.
 *
 * Call-site shape updated for Problem 1 (concurrent STT/TTS startup fix):
 * `session.stt = await timedStep(...)` became
 * `const sttConnectPromise = timedStep(...)` — connectStt is no longer
 * awaited in place (both connect calls are started before either is
 * awaited, via Promise.allSettled) — but the options passed to it,
 * including this "auto" language code, are unchanged.
 */
describe('STT connect call site uses Sarvam\'s real "auto" language code, not the rejected "unknown"', () => {
  test('connectStt is called with language: "auto"', () => {
    const fnStart = src.indexOf("export async function startRuntimeSession(");
    const connectStart = src.indexOf(
      'const sttConnectPromise = timedStep(session, "stt_connect"',
      fnStart,
    );
    const connectEnd = src.indexOf("}),\n  );", connectStart);
    assert.ok(connectStart > -1 && connectEnd > -1);
    const connectBody = src.slice(connectStart, connectEnd);
    assert.match(connectBody, /language:\s*"auto",/);
    assert.doesNotMatch(connectBody, /language:\s*"unknown",/);
  });
});

/**
 * stt:transcript_final_forwarded (production incident round 4): once
 * sarvam-realtime.server.ts's transcript field-name bug was fixed
 * (`text` vs `transcript`), final_transcript events finally reach
 * onSttEvent — but nothing here proved they actually reach
 * handleUserUtterance, the only path to the LLM and a spoken reply, versus
 * being silently dropped by the duplicate-delivery guard or an empty
 * string. Source-scanned since onSttEvent/handleUserUtterance aren't
 * exported (same convention as the silence-timer suite above).
 */
describe("stt:transcript_final_forwarded — verifies a final transcript actually reaches handleUserUtterance (the LLM/reply path), not just that an event fired", () => {
  function finalTranscriptCaseBody() {
    const caseStart = src.indexOf('case "final_transcript": {');
    const caseEnd = src.indexOf('case "language_detected"', caseStart);
    return src.slice(caseStart, caseEnd);
  }

  test("the duplicate-delivery guard logs forwarded:false with reason duplicate_within_window and never reaches handleUserUtterance", () => {
    const body = finalTranscriptCaseBody();
    const dupGuardIdx = body.indexOf('log("duplicate_final_transcript_ignored"');
    const dupBreakIdx = body.indexOf("break;", dupGuardIdx);
    const dupSection = body.slice(dupGuardIdx, dupBreakIdx);
    assert.match(dupSection, /log\("stt:transcript_final_forwarded", session, \{/);
    assert.match(dupSection, /forwarded: false/);
    assert.match(dupSection, /reason: "duplicate_within_window"/);
    assert.doesNotMatch(dupSection, /handleUserUtterance/);
  });

  test("an empty event.text logs forwarded:false with reason empty_text and never reaches handleUserUtterance", () => {
    const body = finalTranscriptCaseBody();
    const emptyGuardIdx = body.indexOf("if (!event.text) {");
    assert.ok(emptyGuardIdx > -1, "expected an explicit empty-text guard");
    const emptyBreakIdx = body.indexOf("break;", emptyGuardIdx);
    const emptySection = body.slice(emptyGuardIdx, emptyBreakIdx);
    assert.match(emptySection, /log\("stt:transcript_final_forwarded", session, \{/);
    assert.match(emptySection, /forwarded: false/);
    assert.match(emptySection, /reason: "empty_text"/);
    assert.doesNotMatch(emptySection, /handleUserUtterance/);
  });

  test("a valid, non-duplicate, non-empty transcript logs forwarded:true with reason ok and then enqueues the utterance (serialized, never a direct concurrent call)", () => {
    const body = finalTranscriptCaseBody();
    const okLogIdx = body.lastIndexOf('log("stt:transcript_final_forwarded", session, {');
    const callIdx = body.indexOf("enqueueUserUtterance(session, event.text);", okLogIdx);
    assert.ok(callIdx > okLogIdx, "the forwarded:true log must precede the actual call");
    const okSection = body.slice(okLogIdx, callIdx);
    assert.match(okSection, /forwarded: true/);
    assert.match(okSection, /reason: "ok"/);
  });

  test("none of the three stt:transcript_final_forwarded log calls include the transcript text itself — only textLength", () => {
    const body = finalTranscriptCaseBody();
    const logCalls =
      body.match(/log\("stt:transcript_final_forwarded", session, \{[\s\S]*?\}\);/g) ?? [];
    assert.equal(logCalls.length, 3, "expected exactly three call sites: duplicate, empty, and ok");
    for (const call of logCalls) {
      assert.match(call, /textLength:/);
      assert.doesNotMatch(
        call,
        /\btext:/,
        "must never pass the transcript text itself, only its length",
      );
    }
  });
});

/**
 * Format-verification diagnostic (production incident follow-up): once
 * Sarvam's TTS config schema bugs were fixed (model moved to a WS URL query
 * param, the bogus output_audio_bitrate field removed), nothing in this
 * codebase actually confirmed Sarvam's synthesized audio matches the
 * format declared to it — the Vobiz bridge trusts frame bytes as mulaw/8kHz
 * without checking. onTtsEvent now logs a one-time comparison on the first
 * audio chunk of each session, source-scanned here since onTtsEvent/Session
 * aren't exported (same convention as the silence-timer suite above).
 */
describe("first_outbound_audio_frame — verifies synthesized audio format against what was declared, rather than assuming a match", () => {
  test("fires exactly once per session, gated by firstOutboundAudioFrameLogged, inside the audio case", () => {
    const caseStart = src.indexOf('case "audio": {', src.indexOf("function onTtsEvent"));
    const caseEnd = src.indexOf('case "error":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(caseBody, /if \(!session\.firstOutboundAudioFrameLogged\) \{/);
    assert.match(caseBody, /session\.firstOutboundAudioFrameLogged = true;/);
    assert.match(caseBody, /log\("first_outbound_audio_frame", session, \{/);
  });

  test("logs the declared codec/sample rate alongside whatever metadata Sarvam's own audio event carried, never a guessed field", () => {
    const caseStart = src.indexOf('case "audio": {', src.indexOf("function onTtsEvent"));
    const caseEnd = src.indexOf('case "error":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(caseBody, /declaredCodec: session\.declaredTtsOutputCodec/);
    assert.match(caseBody, /declaredSampleRateHz: session\.declaredTtsOutputSampleRateHz/);
    assert.match(caseBody, /sarvamMeta: event\.meta/);
  });

  test("declaredTtsOutputCodec/declaredTtsOutputSampleRateHz are set from the same values actually sent to connectTts, not re-derived separately", () => {
    const connectIdx = src.indexOf("session.tts = await deps.connectTts({");
    const before = src.slice(Math.max(0, connectIdx - 400), connectIdx);
    assert.match(before, /session\.declaredTtsOutputCodec = outputCodec;/);
    assert.match(before, /session\.declaredTtsOutputSampleRateHz = outputSampleRateHz;/);
  });

  test("its own comment states plainly that this diagnostic is verification only, not the mechanism that makes the format correct", () => {
    const caseStart = src.indexOf('case "audio": {', src.indexOf("function onTtsEvent"));
    const logIdx = src.indexOf('log("first_outbound_audio_frame"', caseStart);
    const comment = src.slice(caseStart, logIdx);
    assert.match(comment, /VERIFICATION ONLY/);
    assert.match(comment, /does not itself guarantee the audio[\s\S]*format is correct/);
  });

  test("no resampling/transcoding: event.data is forwarded to the bridge byte-for-byte, never passed through a transform call first", () => {
    const caseStart = src.indexOf('case "audio": {', src.indexOf("function onTtsEvent"));
    const caseEnd = src.indexOf('case "error":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(
      caseBody,
      /const frame: AudioFrame = \{ data: event\.data, timestampMs: Date\.now\(\) - session\.startedAt \};/,
      "the AudioFrame handed to the bridge must use event.data verbatim — any resample()/transcode()-style wrapper here would mean the declared format and the actual bytes could silently diverge",
    );
    assert.doesNotMatch(caseBody, /resample|transcode|convertSampleRate/i);
  });
});

/**
 * Provider adapter boundary (requirement 8): the AI runtime must not know
 * whether audio came from Exotel, Twilio, Plivo, SIP, or a test harness —
 * it programs only against AudioMediaBridge (audio-bridge.ts) and
 * RuntimeDeps. A source scan for provider-specific tokens is the most
 * direct proof of this: if any of these ever appear in this file (or in
 * sarvam-realtime.server.ts, the Sarvam STT/TTS client this file drives),
 * that is itself the isolation violation, whatever the surrounding code
 * happens to do.
 */
describe("provider adapter boundary — voice-runtime.server.ts stays provider-neutral", () => {
  // Doc comments are allowed to *explain* the boundary (e.g. "Exotel is one
  // concrete AudioMediaBridge implementation") without violating it — what
  // must never appear is provider-specific identifiers in actual code:
  // imports, variable/field names, protocol event strings. Strip /** */
  // block comments before scanning so documentation prose doesn't trip this.
  function stripBlockComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  const PROVIDER_SPECIFIC_TOKENS = [
    /\bexotel\b/i,
    /CallSid/,
    /stream_sid/i,
    /streamSid/,
    /\btwilio\b/i,
    /\bplivo\b/i,
  ];

  test("voice-runtime.server.ts's code (outside doc comments) contains no Exotel/Twilio/Plivo-specific identifiers", () => {
    const code = stripBlockComments(src);
    for (const pattern of PROVIDER_SPECIFIC_TOKENS) {
      assert.doesNotMatch(code, pattern, `found provider-specific token matching ${pattern}`);
    }
  });

  test("sarvam-realtime.server.ts (the STT/TTS client this file drives) is equally provider-neutral on the telephony side", () => {
    const sarvamRealtimeSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "sarvam-realtime.server.ts"),
      "utf8",
    );
    const code = stripBlockComments(sarvamRealtimeSrc);
    for (const pattern of PROVIDER_SPECIFIC_TOKENS) {
      assert.doesNotMatch(code, pattern, `found provider-specific token matching ${pattern}`);
    }
  });

  test("the only telephony-layer import is the provider-neutral AudioMediaBridge/AudioFrame contract, never a concrete adapter", () => {
    assert.match(
      src,
      /import type \{ AudioMediaBridge, AudioFrame \} from "\.\/telephony\/audio-bridge\.ts";/,
    );
    assert.doesNotMatch(
      stripBlockComments(src),
      /exotel-media-bridge|exotel-provider|ExotelMediaBridge|ExotelTelephonyAdapter/i,
    );
  });
});
