import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findConfiguredService,
  resolveServiceFromText,
  spokenServiceList,
  type ServiceRow,
} from "./service-matching.ts";

/**
 * Smile Dental incident: "Clean my teeth", "to clean my teeth", "Teeth
 * cleaning" and "I want to book teeth cleaning" were never recognised as
 * the configured teeth-cleaning service, so the agent kept asking which
 * service to book. Every expectation below resolves to an id from the
 * catalog under test — the matcher never invents a service.
 */

const SMILE_DENTAL: ServiceRow[] = [
  { id: "svc-teeth-cleaning", name: "Teeth Cleaning", duration_minutes: 30 },
  { id: "svc-whitening", name: "Teeth Whitening", duration_minutes: 60 },
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 90 },
  { id: "svc-consultation", name: "Consultation", duration_minutes: 15 },
  { id: "svc-extraction", name: "Tooth Extraction", duration_minutes: 45 },
];

function resolvedId(rows: ServiceRow[], text: string): string | null {
  const r = resolveServiceFromText(rows, text);
  return r.kind === "match" ? r.row.id : null;
}

describe("caller wording -> the configured teeth-cleaning service", () => {
  for (const phrase of [
    "Clean my teeth",
    "to clean my teeth",
    "Teeth cleaning",
    "I want to book teeth cleaning",
    "teeth cleaning",
    "dental cleaning",
    "cleaning my teeth",
    "I'd like to get my teeth cleaned please",
    // Smile Dental, 2026-10-16: said after 19:30 was chosen; never matched.
    "general cleaning",
    "general clean",
    "General clean.",
  ]) {
    test(`"${phrase}" -> Teeth Cleaning`, () => {
      assert.equal(resolvedId(SMILE_DENTAL, phrase), "svc-teeth-cleaning");
    });
  }

  test("works whatever the clinic named the service", () => {
    const variants: ServiceRow[][] = [
      [{ id: "a", name: "Teeth Cleaning & Polish", duration_minutes: 45 }],
      [{ id: "a", name: "Dental Cleaning", duration_minutes: 30 }],
      [{ id: "a", name: "Scaling and Polishing", duration_minutes: 30 }],
      [{ id: "a", name: "Cleaning", duration_minutes: 30 }],
    ];
    for (const rows of variants) {
      for (const phrase of [
        "Clean my teeth",
        "teeth cleaning",
        "I want to book teeth cleaning",
        "general cleaning",
        "general clean",
      ]) {
        assert.equal(resolvedId(rows, phrase), "a", `${rows[0]!.name} <- ${phrase}`);
      }
    }
  });

  test('"general cleaning" means cleaning, not a general checkup', () => {
    const rows: ServiceRow[] = [
      { id: "svc-checkup", name: "General Checkup", duration_minutes: 20 },
      ...SMILE_DENTAL,
    ];
    for (const phrase of ["general cleaning", "general clean"]) {
      assert.equal(resolvedId(rows, phrase), "svc-teeth-cleaning", phrase);
    }
  });

  test("other services still resolve to their own ids", () => {
    assert.equal(resolvedId(SMILE_DENTAL, "whitening please"), "svc-whitening");
    assert.equal(resolvedId(SMILE_DENTAL, "I need a root canal"), "svc-root-canal");
    assert.equal(resolvedId(SMILE_DENTAL, "just a consultation"), "svc-consultation");
    assert.equal(resolvedId(SMILE_DENTAL, "I need a tooth pulled"), "svc-extraction");
  });

  test("a configured name said verbatim wins, longest first", () => {
    const rows: ServiceRow[] = [
      { id: "short", name: "Cleaning", duration_minutes: 30 },
      { id: "long", name: "Deep Cleaning", duration_minutes: 60 },
    ];
    assert.equal(resolvedId(rows, "I want a deep cleaning"), "long");
  });
});

describe("caller wording -> the configured root canal service", () => {
  // Smile Dental, production: "Root canal" said repeatedly, never matched.
  const PHRASES = [
    "Root canal",
    "Root canal.",
    "root canal treatment",
    "Root canal treatment please",
    "I need a root canal",
    "root canal please",
    // Speech-recognition variants heard on calls.
    "Root kanal",
    "Route canal",
    "rootcanal",
  ];
  for (const phrase of PHRASES) {
    test(`"${phrase}" -> Root Canal Treatment`, () => {
      assert.equal(resolvedId(SMILE_DENTAL, phrase), "svc-root-canal");
    });
  }

  test("works whatever the clinic named it", () => {
    for (const name of ["Root Canal", "Root Canal Treatment", "RCT (Root Canal Therapy)"]) {
      const rows: ServiceRow[] = [
        { id: "rct", name, duration_minutes: 90 },
        { id: "clean", name: "Teeth Cleaning", duration_minutes: 30 },
      ];
      for (const phrase of ["Root canal", "root canal treatment", "Root kanal"]) {
        assert.equal(resolvedId(rows, phrase), "rct", `${name} <- ${phrase}`);
      }
    }
  });

  test("a clinic without a root canal service gets no match, never a guess", () => {
    const noRct = SMILE_DENTAL.filter((r) => r.id !== "svc-root-canal");
    assert.deepEqual(resolveServiceFromText(noRct, "Root canal"), { kind: "none" });
  });
});

describe("never guesses", () => {
  test("words about the body alone never pick a service", () => {
    for (const phrase of ["my tooth hurts", "teeth", "it's about my teeth", "dental"]) {
      assert.deepEqual(resolveServiceFromText(SMILE_DENTAL, phrase), { kind: "none" }, phrase);
    }
  });

  test("booking words, times and yes/no carry no service", () => {
    for (const phrase of [
      "I need an appointment at 4 PM today",
      "yes",
      "book it",
      "My name is Dhanush",
      "use the number I'm calling from",
    ]) {
      assert.deepEqual(resolveServiceFromText(SMILE_DENTAL, phrase), { kind: "none" }, phrase);
    }
  });

  test("a service the clinic doesn't offer is no match", () => {
    assert.deepEqual(resolveServiceFromText(SMILE_DENTAL, "a full body massage"), {
      kind: "none",
    });
    const noCleaning = SMILE_DENTAL.filter((r) => r.id !== "svc-teeth-cleaning");
    assert.deepEqual(resolveServiceFromText(noCleaning, "clean my teeth"), { kind: "none" });
  });

  test("two equally good services are ambiguous, listing exactly those", () => {
    const rows: ServiceRow[] = [
      { id: "basic", name: "Teeth Cleaning", duration_minutes: 30 },
      { id: "deep", name: "Deep Cleaning", duration_minutes: 60 },
      { id: "other", name: "Consultation", duration_minutes: 15 },
    ];
    const result = resolveServiceFromText(rows, "a cleaning");
    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.kind === "ambiguous" ? result.candidates.map((c) => c.id).sort() : [], [
      "basic",
      "deep",
    ]);
  });

  test("no configured services means no match", () => {
    assert.deepEqual(resolveServiceFromText([], "clean my teeth"), { kind: "none" });
  });
});

describe("findConfiguredService (a label the model proposed, or one stored earlier)", () => {
  test("maps free-text labels onto the configured row", () => {
    assert.equal(findConfiguredService(SMILE_DENTAL, "teeth cleaning")?.id, "svc-teeth-cleaning");
    assert.equal(findConfiguredService(SMILE_DENTAL, "TEETH CLEANING")?.id, "svc-teeth-cleaning");
    assert.equal(findConfiguredService(SMILE_DENTAL, "cleaning")?.id, "svc-teeth-cleaning");
    assert.equal(findConfiguredService(SMILE_DENTAL, "dental cleaning")?.id, "svc-teeth-cleaning");
  });

  test("returns null for unknown or empty labels", () => {
    assert.equal(findConfiguredService(SMILE_DENTAL, "massage"), null);
    assert.equal(findConfiguredService(SMILE_DENTAL, ""), null);
    assert.equal(findConfiguredService(SMILE_DENTAL, null), null);
  });

  test("spoken lists read naturally", () => {
    assert.equal(spokenServiceList(SMILE_DENTAL.slice(0, 1)), "Teeth Cleaning");
    assert.equal(
      spokenServiceList(SMILE_DENTAL.slice(0, 2), "or"),
      "Teeth Cleaning or Teeth Whitening",
    );
    assert.equal(
      spokenServiceList(SMILE_DENTAL.slice(0, 3), "and"),
      "Teeth Cleaning, Teeth Whitening and Root Canal Treatment",
    );
  });
});
