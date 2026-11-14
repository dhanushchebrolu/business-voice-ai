import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentSnapshot } from "./agent-instructions.ts";
import { buildUniversalAgentConfig, MASTER_AGENT_TOOLS } from "./universal-agent-config.ts";

function snapshot(over: {
  type?: string;
  caps?: Record<string, boolean>;
  services?: number;
  openDays?: number;
  transfer?: string | null;
  description?: string | null;
  faqs?: number;
}): AgentSnapshot {
  return {
    business: {
      name: "Test Business",
      business_type: over.type ?? "dental_clinic",
      description: over.description === undefined ? "A test business." : over.description,
      country: "IN",
      timezone: "Asia/Kolkata",
      currency: "INR",
    },
    hours: Array.from({ length: 7 }, (_, d) => ({
      day_of_week: d,
      is_closed: d >= (over.openDays ?? 6),
      intervals: d >= (over.openDays ?? 6) ? [] : [{ start: "09:00", end: "18:00" }],
    })),
    services: Array.from({ length: over.services ?? 2 }, (_, i) => ({
      name: `Service ${i}`,
      currency: "INR",
      is_active: true,
    })),
    faqs: Array.from({ length: over.faqs ?? 1 }, () => ({
      question: "Q",
      answer: "A",
      is_active: true,
    })),
    rules: [],
    knowledge: [],
    agent: {
      agent_name: "Aria",
      persona: "friendly",
      objectives: [],
      capabilities: over.caps ?? {},
      primary_language: "en-IN",
      extra_languages: [],
      multilingual: true,
      voice_id: "ritu",
      speaking_pace: 1,
      greetings: {},
      transfer_number: over.transfer ?? null,
      after_hours_behavior: "take_message",
    },
  };
}

const on = (cfg: ReturnType<typeof buildUniversalAgentConfig>) =>
  cfg.capabilities.filter((c) => c.enabled).map((c) => c.id);

describe("universal agent configuration", () => {
  test("one master agent for every industry: every config draws from the same tool set", () => {
    for (const type of [
      "dental_clinic",
      "restaurant",
      "salon",
      "gym",
      "retail",
      "ecommerce",
      "other",
    ]) {
      const cfg = buildUniversalAgentConfig(
        snapshot({ type, caps: { calendar_book: true, capture_lead: true } }),
      );
      assert.deepEqual(
        [...cfg.tools.enable, ...cfg.tools.disable].sort(),
        [...MASTER_AGENT_TOOLS].sort(),
      );
    }
  });

  test("answering questions is always on, with only the always-on tools when nothing else is", () => {
    const cfg = buildUniversalAgentConfig(snapshot({}));
    assert.deepEqual(on(cfg), ["answer_questions"]);
    assert.deepEqual(cfg.tools.enable, [
      "clickai_business_context",
      "get_business_info",
      "record_call_outcome",
    ]);
    assert.deepEqual(cfg.blockers, []);
  });

  test("a clinic with booking gets appointment booking, a restaurant gets reservations — same tools", () => {
    const clinic = buildUniversalAgentConfig(snapshot({ caps: { calendar_book: true } }));
    const restaurant = buildUniversalAgentConfig(
      snapshot({ type: "restaurant", caps: { calendar_book: true } }),
    );
    assert.ok(
      on(clinic).includes("appointment_booking") && !on(clinic).includes("restaurant_reservations"),
    );
    assert.ok(
      on(restaurant).includes("restaurant_reservations") &&
        !on(restaurant).includes("appointment_booking"),
    );
    assert.ok(clinic.tools.enable.includes("book_appointment"));
    assert.ok(restaurant.tools.enable.includes("book_appointment"));
  });

  test("lead capture and message taking each switch on request_callback", () => {
    assert.ok(
      buildUniversalAgentConfig(snapshot({ caps: { capture_lead: true } })).tools.enable.includes(
        "request_callback",
      ),
    );
    assert.ok(
      buildUniversalAgentConfig(snapshot({ caps: { take_callback: true } })).tools.enable.includes(
        "request_callback",
      ),
    );
    assert.ok(buildUniversalAgentConfig(snapshot({})).tools.disable.includes("request_callback"));
  });

  test("call transfer needs a valid number, which is normalized to E.164", () => {
    const ok = buildUniversalAgentConfig(
      snapshot({ caps: { transfer_to_human: true }, transfer: "7900690030" }),
    );
    assert.equal(ok.callTransferNumber, "+917900690030");
    assert.ok(ok.tools.enable.includes("call_transfer"));
    const missing = buildUniversalAgentConfig(snapshot({ caps: { transfer_to_human: true } }));
    assert.match(
      missing.blockers.join(" "),
      /Human call transfer is on but needs a valid transfer phone number/,
    );
    const off = buildUniversalAgentConfig(snapshot({ transfer: "7900690030" }));
    assert.equal(off.callTransferNumber, null, "a stored number alone does not switch transfer on");
  });

  test("missing capability data blocks activation with plain-language reasons", () => {
    const noServices = buildUniversalAgentConfig(
      snapshot({ caps: { calendar_book: true }, services: 0 }),
    );
    assert.match(
      noServices.blockers.join(" "),
      /Appointment booking is on but needs at least one active service/,
    );
    const noHours = buildUniversalAgentConfig(
      snapshot({ caps: { calendar_book: true }, openDays: 0 }),
    );
    assert.match(noHours.blockers.join(" "), /needs opening hours/);
    const nothingToSay = buildUniversalAgentConfig(
      snapshot({ description: null, services: 0, faqs: 0 }),
    );
    assert.match(nothingToSay.blockers.join(" "), /Answer business questions/);
  });

  test("the fingerprint is stable and changes only when the configuration changes", () => {
    const a = buildUniversalAgentConfig(snapshot({ caps: { capture_lead: true } }));
    const b = buildUniversalAgentConfig(snapshot({ caps: { capture_lead: true } }));
    const c = buildUniversalAgentConfig(
      snapshot({ caps: { capture_lead: true, calendar_book: true } }),
    );
    assert.equal(a.fingerprint, b.fingerprint);
    assert.notEqual(a.fingerprint, c.fingerprint);
    assert.match(a.fingerprint, /^u1-[0-9a-f]{8}$/);
  });
});

describe("voice and language (Phase 4A)", () => {
  test("missing settings report a problem; valid ones yield the exact Sarvam config", async () => {
    const { voiceLanguageConfig } = await import("./universal-agent-config.ts");
    assert.match(voiceLanguageConfig(null).problem ?? "", /not set/);
    const ok = voiceLanguageConfig({
      default_language: "Telugu",
      allowed_languages: ["Telugu", "English", "Hindi"],
      auto_language_switch: true,
      sarvam_voice_internal_id: "01a0cf16-897b-76f8-8de9-34f27e861df6",
    });
    assert.equal(ok.problem, null);
    assert.equal(ok.config?.sarvamConfig.language_config.initial_language_name, "Telugu");
    const legacy = voiceLanguageConfig({
      default_language: "Telugu",
      allowed_languages: ["Telugu", "English", "Hindi"],
      auto_language_switch: true,
      sarvam_voice_internal_id: "01a0cf16-5db4-7924-a37d-8f3bb1234d7c",
    });
    assert.match(legacy.problem ?? "", /legacy v3\.1/);
  });
});
