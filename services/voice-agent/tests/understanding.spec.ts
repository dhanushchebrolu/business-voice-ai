import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explicitTimeAnyLanguage } from "../../../src/lib/voice-intent-lexicon.ts";
import { readTime, readUtterance, type ServiceRow } from "../src/conversation/understanding.ts";

const CATALOG: ServiceRow[] = [
  {
    id: "svc-cleaning",
    name: "Cleaning",
    aliases: ["క్లీనింగ్", "क्लीनिंग", "safai"],
    durationMinutes: 30,
  },
  {
    id: "svc-root-canal",
    name: "Root Canal",
    aliases: ["రూట్ కెనాల్", "रूट कैनाल"],
    durationMinutes: 60,
  },
];
const read = (t: string, sttLanguage: string | null = null) =>
  readUtterance(t, { catalog: CATALOG, sttLanguage });
const time = (t: string) => readTime(t);

describe("12 AM vs 12 PM", () => {
  test("explicit forms in English, Hindi and Telugu", () => {
    assert.deepEqual(time("12 AM")?.spec, { kind: "exact", hhmm: "00:00" });
    assert.deepEqual(time("12 PM")?.spec, { kind: "exact", hhmm: "12:00" });
    assert.deepEqual(time("at midnight")?.spec, { kind: "exact", hhmm: "00:00" });
    assert.deepEqual(time("noon")?.spec, { kind: "exact", hhmm: "12:00" });
    assert.deepEqual(time("दोपहर 12 बजे")?.spec, { kind: "exact", hhmm: "12:00" });
    assert.deepEqual(time("मध्यरात्रि 12 बजे")?.spec, { kind: "exact", hhmm: "00:00" });
    assert.deepEqual(time("రాత్రి 12 గంటలకు")?.spec, { kind: "exact", hhmm: "00:00" });
    assert.deepEqual(time("మధ్యాహ్నం 12 గంటలకు")?.spec, { kind: "exact", hhmm: "12:00" });
  });
  test("a bare 12 is uncertain, with both readings kept", () => {
    const t = time("can I come at 12")!;
    assert.equal(t.certainty, "uncertain");
    assert.deepEqual([t.spec, ...t.alternatives].map((x) => (x as { hhmm: string }).hhmm).sort(), [
      "00:00",
      "12:00",
    ]);
  });
  test("REGRESSION in the production lexicon: midnight is read as noon", () => {
    // src/lib/voice-intent-lexicon.ts (production) — documented, not changed here.
    assert.equal(explicitTimeAnyLanguage("मध्यरात्रि 12 बजे"), "12:00");
    assert.equal(
      time("मध्यरात्रि 12 बजे")!.spec.kind === "exact" &&
        (time("मध्यरात्रि 12 बजे")!.spec as { hhmm: string }).hhmm,
      "00:00",
    );
  });
});

describe("2 PM vs 3 PM, after 2 PM", () => {
  test("distinct explicit times", () => {
    assert.deepEqual(time("2 PM")?.spec, { kind: "exact", hhmm: "14:00" });
    assert.deepEqual(time("3 p.m.")?.spec, { kind: "exact", hhmm: "15:00" });
    assert.deepEqual(time("two pm")?.spec, { kind: "exact", hhmm: "14:00" });
    assert.deepEqual(time("दोपहर तीन बजे")?.spec, { kind: "exact", hhmm: "15:00" });
    assert.deepEqual(time("మధ్యాహ్నం రెండు గంటలకు")?.spec, { kind: "exact", hhmm: "14:00" });
  });
  test("'2 or 3 PM' is never collapsed into one", () => {
    const t = time("2 or 3 PM")!;
    assert.equal(t.certainty, "uncertain");
    assert.deepEqual(
      [t.spec, ...t.alternatives],
      [
        { kind: "exact", hhmm: "14:00" },
        { kind: "exact", hhmm: "15:00" },
      ],
    );
  });
  test("'after 2 PM' is a constraint, not a slot", () => {
    assert.deepEqual(time("after 2 PM")?.spec, { kind: "after", hhmm: "14:00" });
    assert.deepEqual(time("2 बजे के बाद")?.spec.kind, "after");
    assert.deepEqual(time("మధ్యాహ్నం 2 తర్వాత")?.spec, { kind: "after", hhmm: "14:00" });
    assert.deepEqual(time("before 11 AM")?.spec, { kind: "before", hhmm: "11:00" });
  });
  test("a bare clinic hour is inferred, not stated", () => {
    const t = time("at 4")!;
    assert.equal(t.certainty, "inferred");
    assert.deepEqual(t.spec, { kind: "exact", hhmm: "16:00" });
    assert.deepEqual(t.alternatives, [{ kind: "exact", hhmm: "04:00" }]);
  });
  test("negated times are taken back (English before, Hindi/Telugu after)", () => {
    assert.deepEqual(time("no, 3 PM not 2")?.spec, { kind: "exact", hhmm: "15:00" });
    assert.deepEqual(time("not 2, make it 3 PM")?.spec, { kind: "exact", hhmm: "15:00" });
    assert.deepEqual(time("शाम 3 बजे नहीं, 4 बजे")?.spec, { kind: "exact", hhmm: "16:00" });
    assert.deepEqual(time("సాయంత్రం 3 కాదు, 4 గంటలకు")?.spec, { kind: "exact", hhmm: "16:00" });
  });
});

describe("languages and code-switching", () => {
  test("language by script, romanized by the STT hint", () => {
    assert.equal(read("నాకు అపాయింట్మెంట్ బుక్ చేయాలి").language, "te-IN");
    assert.equal(read("आज शाम चार बजे क्लीनिंग चाहिए").language, "hi-IN");
    assert.equal(read("I want a cleaning").language, "en-IN");
    assert.equal(read("kal char baje aana hai", "hi-IN").language, "hi-IN");
  });
  test("mid-sentence switching keeps every detail", () => {
    const r = read("రేపు evening 5 PM కి cleaning బుక్ చేయండి");
    assert.equal(r.language, "te-IN");
    assert.equal(r.intent, "book");
    assert.deepEqual(r.date?.value, { kind: "relative", days: 1 });
    assert.deepEqual(r.time?.spec, { kind: "exact", hhmm: "17:00" });
    assert.deepEqual(
      r.services.map((s) => s.id),
      ["svc-cleaning"],
    );
    const h = read("Tomorrow शाम 4 बजे root canal चाहिए");
    assert.deepEqual(h.time?.spec, { kind: "exact", hhmm: "16:00" });
    assert.deepEqual(
      h.services.map((s) => s.id),
      ["svc-root-canal"],
    );
  });
  test("Hindi 'kal' is inferred as tomorrow, not stated", () => {
    assert.deepEqual(read("कल चार बजे").date, {
      value: { kind: "relative", days: 1 },
      certainty: "inferred",
      evidence: "tomorrow",
    });
  });
});

describe("short confirmations, denials, corrections, noise", () => {
  test("short yes in three languages", () => {
    for (const t of ["yes", "ok", "haan ji", "हाँ", "जी", "ठीक है", "అవును", "సరే", "హా"])
      assert.equal(read(t).affirm, true, t);
  });
  test("short no, and 'no problem' is not a no", () => {
    for (const t of ["no", "नहीं", "కాదు", "వద్దు"]) assert.equal(read(t).deny, true, t);
    assert.equal(read("no problem").deny, false);
  });
  test("a service correction is marked as one", () => {
    const r = read("actually make it root canal");
    assert.equal(r.correction, true);
    assert.deepEqual(
      r.services.map((s) => s.id),
      ["svc-root-canal"],
    );
  });
  test("background noise and fillers carry nothing", () => {
    for (const t of ["", "hmm", "[noise]", "(inaudible)", "...", "uhh", "हम्म"])
      assert.equal(read(t).noise, true, JSON.stringify(t));
  });
  test("'one' in 'yes that one' / 'ek minute' is not a time", () => {
    assert.equal(read("yes that one").time, null);
    assert.equal(read("the first one please").time, null);
    assert.equal(read("ek minute ruko", "hi-IN").time, null);
    assert.deepEqual(read("at four").time?.spec, { kind: "exact", hhmm: "16:00" });
    assert.deepEqual(read("char baje", "hi-IN").time?.spec, { kind: "exact", hhmm: "16:00" });
  });
  test("a spoken phone number is digits, never a time", () => {
    const r = read("my number is nine eight seven six five four three two one zero");
    assert.equal(r.phoneDigits, "9876543210");
    assert.equal(r.time, null);
  });
  test("names in three languages", () => {
    assert.equal(read("నా పేరు ధనుష్").name, "ధనుష్");
    assert.equal(read("मेरा नाम धनुष है").name, "धनुष");
    assert.equal(read("my name is Ravi").name, "Ravi");
  });
});
