import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  callingWindow,
  hasPriorRelationship,
  isDestinationCountryAllowed,
  outboundCallingDisabled,
  staticEligibilityBlocker,
  withinCallingHours,
} from "./outbound-eligibility.server.ts";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

/** An instant at the given India wall-clock time (IST is UTC+05:30, no DST). */
const ist = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, 19, h! - 5, m! - 30));
};

describe("kill switch", () => {
  test("only an explicit true stops calls", () => {
    for (const v of ["true", "TRUE", " true "])
      assert.equal(withEnv({ OUTBOUND_CALLING_DISABLED: v }, outboundCallingDisabled), true, v);
    for (const v of [undefined, "", "false", "1", "yes"])
      assert.equal(withEnv({ OUTBOUND_CALLING_DISABLED: v }, outboundCallingDisabled), false, v);
  });
});

describe("destination country", () => {
  test("Indian numbers only by default", () => {
    withEnv({ OUTBOUND_ALLOWED_COUNTRY_CODES: undefined }, () => {
      assert.ok(isDestinationCountryAllowed("+919876543210"));
      assert.ok(!isDestinationCountryAllowed("+14155550123"));
      assert.ok(!isDestinationCountryAllowed("+447700900123"));
    });
  });

  test("a configured list is honoured; an empty or junk list allows nothing", () => {
    withEnv({ OUTBOUND_ALLOWED_COUNTRY_CODES: "91, +44" }, () => {
      assert.ok(isDestinationCountryAllowed("+447700900123"));
      assert.ok(!isDestinationCountryAllowed("+14155550123"));
    });
    for (const v of [",", "abc", "  "])
      withEnv({ OUTBOUND_ALLOWED_COUNTRY_CODES: v }, () =>
        assert.equal(
          isDestinationCountryAllowed("+919876543210"),
          v.trim() === "",
          `"${v}": blank means the default, junk means nothing`,
        ),
      );
  });
});

describe("calling hours (India time)", () => {
  test("09:00 to 20:59 inclusive by default", () => {
    withEnv({ OUTBOUND_CALLING_HOURS: undefined }, () => {
      for (const t of ["09:00", "12:30", "20:59"]) assert.ok(withinCallingHours(ist(t)), t);
      for (const t of ["08:59", "21:00", "23:30", "00:00", "03:00"])
        assert.ok(!withinCallingHours(ist(t)), t);
    });
  });

  test("the setting can narrow the window but never widen it", () => {
    assert.deepEqual(withEnv({ OUTBOUND_CALLING_HOURS: "10-18" }, callingWindow), {
      startHour: 10,
      endHour: 18,
    });
    for (const v of ["0-24", "8-21", "9-22", "18-10", "9", "nine-five", ""])
      assert.deepEqual(
        withEnv({ OUTBOUND_CALLING_HOURS: v }, callingWindow),
        { startHour: 9, endHour: 21 },
        v,
      );
    withEnv({ OUTBOUND_CALLING_HOURS: "10-18" }, () => {
      assert.ok(!withinCallingHours(ist("09:30")));
      assert.ok(withinCallingHours(ist("17:59")));
      assert.ok(!withinCallingHours(ist("18:00")));
    });
  });

  test("the order of the static checks: kill switch, then country, then hours", () => {
    withEnv({ OUTBOUND_CALLING_DISABLED: "true" }, () =>
      assert.match(staticEligibilityBlocker("+14155550123", ist("03:00"))!, /paused/),
    );
    assert.match(staticEligibilityBlocker("+14155550123", ist("03:00"))!, /\+91/);
    assert.match(staticEligibilityBlocker("+919876543210", ist("03:00"))!, /9:00 AM/);
    assert.equal(staticEligibilityBlocker("+919876543210", ist("11:00")), null);
  });
});

describe("prior relationship", () => {
  const PERSON = "+919876543210";
  const setup = (tables: Record<string, Record<string, unknown>[]>) =>
    memorySupabase({
      tables: { contacts: [], call_logs: [], leads: [], bookings: [], ...tables },
    }).client;

  test("a contact, an inbound call, a lead or a booking from the number qualifies", async () => {
    const sources: Record<string, Record<string, unknown>[]> = {
      contacts: [{ organization_id: "org_a", phone: PERSON }],
      call_logs: [{ organization_id: "org_a", direction: "inbound", caller_number: PERSON }],
      leads: [{ organization_id: "org_a", phone: PERSON }],
      bookings: [{ organization_id: "org_a", customer_phone: PERSON }],
    };
    for (const [table, rows] of Object.entries(sources))
      assert.ok(await hasPriorRelationship(setup({ [table]: rows }), "org_a", PERSON), table);
  });

  test("nothing from another customer, and an earlier OUTBOUND call alone, does not", async () => {
    const client = setup({
      contacts: [{ organization_id: "org_b", phone: PERSON }],
      call_logs: [
        { organization_id: "org_b", direction: "inbound", caller_number: PERSON },
        { organization_id: "org_a", direction: "outbound", caller_number: PERSON },
      ],
      leads: [{ organization_id: "org_b", phone: PERSON }],
      bookings: [{ organization_id: "org_b", customer_phone: PERSON }],
    });
    assert.equal(await hasPriorRelationship(client, "org_a", PERSON), false);
  });
});
