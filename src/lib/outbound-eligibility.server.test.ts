import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  callingWindow,
  hasPriorRelationship,
  isDestinationCountryAllowed,
  isOutboundDestinationAllowlisted,
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

describe("pilot allowlist (SARVAM_OUTBOUND_TEST_ALLOWLIST) fails closed (GATE C4 H2)", () => {
  const KEY = "SARVAM_OUTBOUND_TEST_ALLOWLIST";
  function withAllowlist(value: string | undefined, fn: () => void) {
    const prior = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      fn();
    } finally {
      if (prior === undefined) delete process.env[KEY];
      else process.env[KEY] = prior;
    }
  }
  const allowed = (to: string) => isOutboundDestinationAllowlisted(to);

  test("missing: nothing is allowed", () =>
    withAllowlist(undefined, () => assert.equal(allowed("+919876543210"), false)));

  test("empty: nothing is allowed", () =>
    withAllowlist("", () => assert.equal(allowed("+919876543210"), false)));

  test("whitespace or separators only: nothing is allowed", () => {
    for (const value of ["   ", "\t\n", " , ,, "])
      withAllowlist(value, () =>
        assert.equal(allowed("+919876543210"), false, JSON.stringify(value)),
      );
  });

  test("malformed entries are ignored and never widen the list", () => {
    withAllowlist("not-a-number, *, +, 98765, all, +919876543210", () => {
      assert.equal(allowed("+919876543210"), true);
      assert.equal(allowed("+919876543211"), false);
      assert.equal(allowed("+912222222222"), false);
    });
    withAllowlist("*", () => assert.equal(allowed("+919876543210"), false));
    withAllowlist("garbage", () => assert.equal(allowed("+919876543210"), false));
  });

  test("a listed number is allowed; any other is not", () =>
    withAllowlist("+919876543210", () => {
      assert.equal(allowed("+919876543210"), true);
      assert.equal(allowed("+918888888888"), false);
    }));

  test("both sides are normalized to E.164 before comparing", () => {
    withAllowlist("0091 98765 43210, +91-88888-88888", () => {
      assert.equal(allowed("+919876543210"), true);
      assert.equal(allowed("+91 98765-43210"), true);
      assert.equal(allowed("+918888888888"), true);
    });
    withAllowlist("+919876543210", () => assert.equal(allowed("0091 98765 43210"), true));
  });

  test("no partial, prefix or suffix matching", () =>
    withAllowlist("+919876543210", () => {
      for (const to of [
        "+9198765432", // a prefix of the entry
        "+19876543210", // the same digits under another country code
        "+9198765432100", // the entry with more digits
        "+449876543210", // the same subscriber digits elsewhere
        "",
        "not-a-number",
      ])
        assert.equal(allowed(to), false, to);
    }));
});

describe("every outbound path checks the pilot allowlist; no bypass (GATE C4 H2)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => readFileSync(join(here, p), "utf8").replace(/\r\n/g, "\n");
  const single = read("sarvam-outbound-call.server.ts");
  const campaign = read("campaign-dispatch.server.ts");
  const livekit = read("voice-agent/outbound.server.ts");

  /** In `src`, `check` (the allowlist refusal) comes before `later` (a write, admission or dial). */
  const before = (src: string, check: string, later: string) => {
    const c = src.indexOf(check);
    const l = src.indexOf(later);
    assert.ok(c > -1, `missing: ${check}`);
    assert.ok(l > -1, `missing: ${later}`);
    assert.ok(c < l, `${check} must come before ${later}`);
  };

  test("single and admin test calls: refused before the database, admission or Sarvam", () => {
    const fn = single.slice(single.indexOf("export async function sendSarvamInstantOutboundCall"));
    const check =
      "if (!isOutboundDestinationAllowlisted(toE164)) throw new Error(OUTBOUND_TEST_ALLOWLIST_MESSAGE);";
    before(fn, check, '.from("phone_numbers")');
    before(fn, check, 'rpc("admit_single_outbound_call"');
    before(fn, check, "adapter.createInstantOutbound(");
  });

  test("campaign dispatcher: refused before the claim, admission and Sarvam", () => {
    const check = "if (!isOutboundDestinationAllowlisted(destination)) {";
    before(campaign, check, '.update({ status: "calling", attempts, current_call_id: callId })');
    before(campaign, check, ".admitCampaignCall({");
    before(campaign, check, "adapter.createInstantOutbound(");
  });

  test("LiveKit agent call: refused before any read, so a replayed request cannot re-dispatch", () => {
    const fn = livekit.slice(livekit.indexOf("export async function startOutboundAgentCall"));
    const check = "if (!isOutboundDestinationAllowlisted(input.toE164))";
    before(fn, check, '.from("phone_numbers")');
    before(fn, check, '.from("call_logs")');
    before(fn, check, "dispatchOnce(deps, callId)");
    before(fn, check, "prepareOutboundSipCall(");
  });

  test("admission and the Sarvam dial are only called from these checked paths", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(join(here, ".."));
    const users = (pattern: RegExp) =>
      files
        .filter((f) => pattern.test(readFileSync(f, "utf8")))
        .map((f) =>
          f
            .split(sep)
            .join("/")
            .replace(/^.*\/src\//, "src/"),
        )
        .sort();
    assert.deepEqual(users(/rpc\("admit_(single|campaign)_outbound_call"/), [
      "src/lib/campaign-dispatch.server.ts",
      "src/lib/sarvam-outbound-call.server.ts",
    ]);
    assert.deepEqual(users(/\.createInstantOutbound\(/), [
      "src/lib/campaign-dispatch.server.ts",
      "src/lib/sarvam-outbound-call.server.ts",
    ]);
  });
});
