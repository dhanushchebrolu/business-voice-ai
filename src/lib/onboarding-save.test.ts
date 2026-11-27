import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSetupPayload,
  formFromSaved,
  hasMixedHours,
  loadSetup,
  saveOnboarding,
  type OnboardingForm,
  type SavedSetup,
} from "./onboarding-save.ts";
import { getBusinessType } from "./business-types.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";

/**
 * The setup wizard in the browser: what it loads, how it prefills and what it sends. What the
 * database then does with it (atomic, serialized, never overwriting with blanks) is tested on
 * real PostgreSQL: supabase/migrations/business_setup_save.pg.test.ts.
 */

const ORG = "org_wizard";
const BREAKS = [
  { start: "09:00", end: "12:00" },
  { start: "14:00", end: "18:00" },
];

const SAVED: SavedSetup = {
  business: {
    business_type: "dental_clinic",
    name: "Bright Dental",
    description: "Clinic.",
    address: "1 Main Road",
    city: "Chennai",
    state: "TN",
    postal_code: "600001",
    primary_phone: "+91 90000 00000",
    email: "front@example.com",
    website: "https://example.com",
  },
  hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    day_of_week: d,
    is_closed: d === 0,
    intervals: d === 0 ? [] : [{ start: "10:00", end: "18:00" }],
  })),
  services: [
    { id: "s1", name: "Cleaning", price: 500 },
    { id: "s2", name: "Braces", price: null },
  ],
  agent: {
    agent_name: "Meera",
    primary_language: "ta-IN",
    voice_id: "ritu",
    greetings: { "ta-IN": "Vanakkam.", "en-IN": "Hello." },
  },
};
const EMPTY: SavedSetup = { business: null, hours: [], services: [], agent: null };

function send(from: SavedSetup, type: (f: OnboardingForm) => void = () => {}) {
  const loaded = formFromSaved(from);
  const form = structuredClone(loaded);
  type(form);
  return buildSetupPayload(form, loaded, "Default greeting.");
}
const NOTHING = { business: {}, hours: [], services: [], agent: {} };

describe("prefilling", () => {
  test("every saved field is shown", () => {
    const form = formFromSaved(SAVED);
    assert.equal(form.typeId, "dental_clinic");
    assert.deepEqual({ ...form.info, business_type: "dental_clinic" }, SAVED.business);
    assert.deepEqual(
      [form.openDays, form.openTime, form.closeTime],
      [[1, 2, 3, 4, 5, 6], "10:00", "18:00"],
    );
    assert.deepEqual(form.items, [
      { id: "s1", name: "Cleaning", price: "500" },
      { id: "s2", name: "Braces", price: "" },
    ]);
    assert.deepEqual(
      [form.agentName, form.language, form.voiceId, form.greeting],
      ["Meera", "ta-IN", "ritu", "Vanakkam."],
    );
  });

  test("nothing saved: the usual starting form", () => {
    const form = formFromSaved(EMPTY);
    assert.deepEqual([form.typeId, form.info.name, form.agentName], ["", "", "Aria"]);
    assert.deepEqual(form.openDays, [1, 2, 3, 4, 5, 6]);
    assert.equal(form.items.length, 3);
  });

  test("partly saved: saved parts shown, the rest at their defaults", () => {
    const form = formFromSaved({
      ...EMPTY,
      business: { business_type: "other", name: "Half", city: null },
      hours: [{ day_of_week: 2, is_closed: false, intervals: [{ from: "9", to: "5" }] }],
    });
    assert.deepEqual([form.info.name, form.info.city, form.info.email], ["Half", "", ""]);
    assert.deepEqual([form.openDays, form.openTime], [[2], "09:00"], "an old hours shape");
    assert.deepEqual([form.agentName, form.language], ["Aria", "en-IN"]);
  });

  test("days with different hours or breaks are flagged", () => {
    assert.equal(hasMixedHours(SAVED), false);
    const withBreak = structuredClone(SAVED);
    withBreak.hours[1]!.intervals = BREAKS;
    assert.equal(hasMixedHours(withBreak), true);
    assert.equal(hasMixedHours(EMPTY), false);
  });
});

describe("what is sent", () => {
  test("opening and submitting a saved setup sends no change", () => {
    assert.deepEqual(send(SAVED).changes, NOTHING);
    const mixed = structuredClone(SAVED);
    mixed.hours[1]!.intervals = BREAKS;
    assert.deepEqual(send(mixed).changes, NOTHING);
  });

  test("cleared fields are not sent, so saved values stay", () => {
    const { changes } = send(SAVED, (f) => {
      for (const key of Object.keys(f.info) as (keyof typeof f.info)[]) f.info[key] = "  ";
      f.agentName = "";
      f.greeting = "";
      f.items = [
        { id: "s1", name: "", price: "" },
        { id: "s2", name: "", price: "" },
        { name: " ", price: "10" },
      ];
    });
    assert.deepEqual(changes, NOTHING);
  });

  test("only edited fields are sent", () => {
    const { changes } = send(SAVED, (f) => {
      f.info.name = " Renamed ";
      f.items[1]!.price = "900";
      f.items.push({ name: "Whitening", price: "abc" });
      f.voiceId = "simran";
    });
    assert.deepEqual(changes, {
      business: { name: "Renamed" },
      hours: [],
      services: [
        { id: "s2", name: "Braces", price: 900 },
        { name: "Whitening", price: null },
      ],
      agent: { voice_id: "simran" },
    });
  });

  test("toggling a day sends that day only; changing the time sends the open days", () => {
    const toggled = send(SAVED, (f) => (f.openDays = [0, 1, 2, 3, 4, 5]));
    assert.deepEqual(
      toggled.changes.hours.map((h) => [h.day_of_week, h.is_closed]),
      [
        [0, false],
        [6, true],
      ],
    );
    assert.deepEqual(toggled.changes.hours[1]!.intervals, []);
    const later = send(SAVED, (f) => (f.closeTime = "20:00"));
    assert.deepEqual(
      later.changes.hours.map((h) => h.day_of_week),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(later.changes.hours[0]!.intervals, [{ start: "10:00", end: "20:00" }]);
  });

  test("a new customer: typed answers are changes, defaults only fill what is missing", () => {
    const { initial, changes } = send(EMPTY, (f) => {
      f.typeId = "dental_clinic";
      f.info.name = "New";
    });
    assert.deepEqual(changes, {
      business: { business_type: "dental_clinic", name: "New" },
      hours: [],
      services: [],
      agent: {},
    });
    assert.equal(initial.hours.length, 7);
    assert.equal(initial.agent.greeting, "Default greeting.");
    assert.deepEqual(initial.business, { business_type: "dental_clinic", name: "New" });
    const type = getBusinessType("dental_clinic");
    assert.deepEqual(
      [initial.faqs.length, initial.rules.length],
      [type.suggestedFaqs.length, type.suggestedRules.length],
    );
  });
});

function database() {
  return memorySupabase({
    tables: {
      agent_configs: [
        {
          id: "a1",
          organization_id: ORG,
          business_id: "b2",
          agent_name: "Meera",
          created_at: "2026-01-02",
        },
        { id: "ax", organization_id: "other", business_id: "bx", created_at: "2025-01-01" },
      ],
      businesses: [
        { id: "b1", organization_id: ORG, name: "First", created_at: "2026-01-01" },
        { id: "b2", organization_id: ORG, name: "Second", created_at: "2026-01-02" },
        { id: "bx", organization_id: "other", name: "Other", created_at: "2025-01-01" },
      ],
      business_hours: [
        { id: "h2", business_id: "b2", day_of_week: 1, is_closed: false, intervals: [] },
        { id: "hx", business_id: "bx", day_of_week: 2, is_closed: false, intervals: [] },
      ],
      services: [
        { id: "s2", business_id: "b2", name: "Mine", price: 1, sort_order: 0 },
        { id: "sx", business_id: "bx", name: "Theirs", price: 1, sort_order: 0 },
      ],
    },
  });
}

describe("loading what is saved", () => {
  test("the receptionist's business, and only this customer's records", async () => {
    const s = await loadSetup(database().client, ORG);
    assert.equal(s.business!.name, "Second");
    assert.deepEqual([s.hours.length, s.services.map((x) => x.name)], [1, ["Mine"]]);
    assert.equal(s.agent!.agent_name, "Meera");
  });

  test("without a receptionist: the first business", async () => {
    const db = database();
    db.tables["agent_configs"] = [];
    assert.equal((await loadSetup(db.client, ORG)).business!.name, "First");
    assert.deepEqual(await loadSetup(db.client, "nobody"), EMPTY);
  });

  for (const table of ["agent_configs", "businesses", "business_hours", "services"])
    test(`a failed read of ${table} is an error, never an empty form`, async () => {
      const db = database();
      db.failNext(table, "select", { message: `${table} unavailable` });
      await assert.rejects(loadSetup(db.client, ORG), { message: `${table} unavailable` });
    });
});

describe("saving", () => {
  const client = (reply: { data?: unknown; error?: { message: string } | null }) => {
    const calls: unknown[] = [];
    return {
      calls,
      client: {
        rpc: async (name: string, args: unknown) => {
          calls.push([name, args]);
          return { data: reply.data ?? null, error: reply.error ?? null };
        },
      } as never,
    };
  };

  test("one database call carries the whole save", async () => {
    const c = client({ data: { created_agent: true } });
    const payload = send(SAVED);
    assert.deepEqual(await saveOnboarding(c.client, ORG, payload), { createdAgent: true });
    assert.deepEqual(c.calls, [
      ["save_business_setup", { _org: ORG, _initial: payload.initial, _changes: payload.changes }],
    ]);
  });

  test("a failure is reported, in plain words where known", async () => {
    const fail = (message: string) =>
      saveOnboarding(client({ error: { message } }).client, ORG, send(SAVED));
    await assert.rejects(fail("network down"), /network down/);
    await assert.rejects(fail("BUSINESS_SETUP_NAME_REQUIRED"), /Add your business name/);
  });
});

describe("the pages", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  test("the wizard opens only with the saved data loaded, and offers a retry when it cannot", () => {
    const page = read("../routes/app.onboarding.tsx");
    assert.match(page, /if \(!orgId \|\| !setup\.data\)/);
    assert.match(page, /queryFn: \(\) => loadSetup\(supabase, orgId!\)/);
    assert.match(page, /could not load your saved business details/);
    assert.match(page, /Try again/);
    assert.match(page, /gcTime: 0/);
    assert.match(page, /useState\(\(\) => formFromSaved\(saved\)\)/);
    // The browser writes nothing itself: one database call.
    assert.doesNotMatch(page, /supabase\s*\.from\(/);
  });

  test("sends a customer with an unfinished setup back to the wizard", () => {
    const app = read("../routes/app.tsx");
    assert.match(app, /ws\.setupIncomplete &&\s*pathname !== "\/app\/onboarding"/);
    const workspace = read("./workspace.ts");
    assert.match(workspace, /if \(businessRes\.error\) throw businessRes\.error;/);
    assert.match(workspace, /if \(agentError\) throw agentError;/);
    assert.match(workspace, /setupIncomplete = !data\?\.length;/);
  });
});
