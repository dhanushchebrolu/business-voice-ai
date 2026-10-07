import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  checkCallTransition,
  maskPhoneNumber,
  TERMINAL_CALL_STATUSES,
} from "./telephony-guard.server.ts";

test("maskPhoneNumber: keeps only the last 4 digits, masking the rest", () => {
  assert.equal(maskPhoneNumber("+919876543210"), "********3210");
});

test("maskPhoneNumber: handles a null/undefined/empty input without throwing", () => {
  assert.equal(maskPhoneNumber(null), "(none)");
  assert.equal(maskPhoneNumber(undefined), "(none)");
  assert.equal(maskPhoneNumber(""), "(none)");
});

test("maskPhoneNumber: a short numeric string masks fully rather than exposing every digit", () => {
  assert.equal(maskPhoneNumber("123"), "***");
});

test("checkCallTransition: same-state event is a no-op, not an error", () => {
  const r = checkCallTransition("in_progress", "in_progress");
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
});

test("checkCallTransition: normal forward progression is allowed", () => {
  assert.equal(checkCallTransition("initiated", "ringing").ok, true);
  assert.equal(checkCallTransition("ringing", "answered").ok, true);
  assert.equal(checkCallTransition("answered", "in_progress").ok, true);
  assert.equal(checkCallTransition("in_progress", "completed").ok, true);
});

test("checkCallTransition: rejects completed -> in_progress", () => {
  const r = checkCallTransition("completed", "in_progress");
  assert.equal(r.ok, false);
  assert.ok(r.reason?.includes("completed -> in_progress"));
});

test("checkCallTransition: rejects failed -> answered", () => {
  const r = checkCallTransition("failed", "answered");
  assert.equal(r.ok, false);
});

test("checkCallTransition: every terminal status has no outgoing transitions", () => {
  for (const status of TERMINAL_CALL_STATUSES) {
    const r = checkCallTransition(status, "answered");
    assert.equal(r.ok, false, `${status} -> answered should be rejected`);
  }
});

/**
 * Task 10 (production incident): a real call was answered and had a full
 * conversation, but call_logs was still "ringing" when the provider's
 * "completed" webhook arrived (most plausibly an out-of-order/dropped
 * "answered" webhook, a separate REST channel from the media stream that
 * actually runs the call) — `ringing -> completed` was illegal, so the
 * webhook handler logged telephony:illegal_transition and left the row
 * stuck at "ringing" forever, with the call's duration/billing never
 * recorded. "completed" is now allowed directly from "initiated"/
 * "ringing", consistent with the OTHER terminal statuses the table
 * already allowed from both of those states.
 */
describe("checkCallTransition — ringing/initiated -> completed (test 10: out-of-order terminal webhook recovery)", () => {
  test("ringing -> completed is now allowed, not an illegal transition", () => {
    const r = checkCallTransition("ringing", "completed");
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
  });

  test("initiated -> completed is now allowed too", () => {
    const r = checkCallTransition("initiated", "completed");
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
  });

  test("this is not a blanket allow-anything change — completed -> in_progress is still rejected", () => {
    assert.equal(checkCallTransition("completed", "in_progress").ok, false);
  });

  test("ringing/initiated -> completed is consistent with the OTHER terminal statuses already allowed from both states", () => {
    for (const terminal of ["failed", "busy", "no_answer", "cancelled"] as const) {
      assert.equal(checkCallTransition("ringing", terminal).ok, true);
      assert.equal(checkCallTransition("initiated", terminal).ok, true);
    }
  });
});

describe('resolveActivePhoneNumberByDestination: production incident regression — +918071580870 provisioned with provider stored as "Vobiz" (free-text admin field, no casing validation) must still resolve against this codebase\'s lowercase-literal provider id "vobiz"', () => {
  // No live Postgres instance is available in this environment (same
  // documented limitation as every supabase/migrations/*.test.ts file in
  // this repo) — checkTelephonyAccess/resolveActivePhoneNumberByDestination
  // both resolve `supabaseAdmin` via a dynamic import, not dependency
  // injection, so the real .ilike() query itself is a NEEDS LIVE TEST item.
  // What this file CAN and does prove: (1) the source uses a
  // case-insensitive match, not the exact-match that caused the incident,
  // and (2) the matching RULE itself — mirroring Postgres ILIKE with no
  // wildcards (a plain case-insensitive equality, which is all this call
  // site ever passes it: a literal provider id, never a pattern) — behaves
  // correctly for the exact real-world row this incident involves.

  const guardSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "telephony-guard.server.ts"),
    "utf8",
  );

  test("the shared resolver matches provider case-insensitively (.ilike), not with the exact-match .eq that caused the incident", () => {
    const fnStart = guardSrc.indexOf(
      "export async function resolveActivePhoneNumberByDestination(",
    );
    assert.ok(fnStart > -1, "expected the shared resolver to exist in telephony-guard.server.ts");
    const fnBody = guardSrc.slice(fnStart, guardSrc.indexOf("\n}\n", fnStart));
    assert.match(fnBody, /\.eq\("e164", destinationE164\)/);
    assert.match(fnBody, /\.ilike\("provider", provider\)/);
    assert.match(fnBody, /\.eq\("status", "active"\)/);
    assert.doesNotMatch(fnBody, /\.eq\("provider", provider\)/);
  });

  test('ILIKE-with-no-wildcards semantics (a plain case-insensitive equality — the only pattern shape this call site ever passes) resolve "Vobiz" against the query value "vobiz" for the real incident number', () => {
    // Mirrors exactly what Postgres ILIKE does for a pattern with no
    // special characters: a case-insensitive string comparison. The real
    // call site never passes `%`/`_` wildcards — `provider` is always one
    // of this codebase's own literal ids ("vobiz", "exotel", ...), never
    // user input — so this is a faithful, if locally-reproduced, model of
    // the production query's actual matching behavior for this row.
    function matchesIlikeLiteral(column: string, pattern: string): boolean {
      return column.toLowerCase() === pattern.toLowerCase();
    }

    const row = {
      e164: "+918071580870",
      provider: "Vobiz", // exactly as stored in production
      status: "active",
    };
    const queriedDestination = "+918071580870"; // event.destinationE164, already normalized
    const queriedProvider = "vobiz"; // the literal this codebase's call sites pass

    const resolved =
      row.e164 === queriedDestination &&
      matchesIlikeLiteral(row.provider, queriedProvider) &&
      row.status === "active";

    assert.equal(
      resolved,
      true,
      'the Vobiz row (provider stored as "Vobiz") must resolve for destination +918071580870',
    );

    // The old exact-match behavior is the one being fixed — pinned here so
    // a future revert back to .eq would be caught by this same test file.
    const resolvedUnderOldExactMatch =
      row.e164 === queriedDestination &&
      row.provider === queriedProvider && // .eq("provider", "vobiz") — case-sensitive
      row.status === "active";
    assert.equal(
      resolvedUnderOldExactMatch,
      false,
      'confirms the OLD exact-match behavior is exactly what caused the incident — "Vobiz" !== "vobiz"',
    );
  });

  test("case-insensitive matching is a pure widening — it cannot change the result for an already-correctly-lowercase-cased row (e.g. Exotel's own)", () => {
    function matchesIlikeLiteral(column: string, pattern: string): boolean {
      return column.toLowerCase() === pattern.toLowerCase();
    }
    const exotelRow = { provider: "exotel" };
    assert.equal(matchesIlikeLiteral(exotelRow.provider, "exotel"), true);
    assert.equal(
      exotelRow.provider === "exotel", // what .eq("provider", "exotel") would have matched
      matchesIlikeLiteral(exotelRow.provider, "exotel"), // what .ilike(...) now matches
      "exact-match and case-insensitive-match must agree for an already-lowercase row — Exotel's behavior is unchanged",
    );
  });

  test("both callers (vobiz-answer.ts and telephony.ts) use the shared resolver — the fix is centralized, not duplicated", () => {
    const vobizAnswerSrc = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "routes",
        "api",
        "public",
        "webhooks",
        "vobiz-answer.ts",
      ),
      "utf8",
    );
    const telephonySrc = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "routes",
        "api",
        "public",
        "webhooks",
        "telephony.ts",
      ),
      "utf8",
    );
    assert.match(vobizAnswerSrc, /resolveActivePhoneNumberByDestination\("vobiz", calledNumber\)/);
    assert.match(
      telephonySrc,
      /resolveActivePhoneNumberByDestination\(providerId, destinationNumber\)/,
    );
    // Neither file inlines its own .eq("provider", ...) phone_numbers
    // match anymore for destination resolution (call_logs lookups for
    // outbound correlation are untouched — a separate, unconfirmed-as-
    // affected concern).
    assert.doesNotMatch(
      vobizAnswerSrc,
      /\.from\("phone_numbers"\)\s*\n\s*\.select\("id, organization_id"\)/,
    );
    assert.doesNotMatch(
      telephonySrc,
      /\.from\("phone_numbers"\)\s*\n\s*\.select\("\*"\)\s*\n\s*\.eq\("e164", destinationNumber\)\s*\n\s*\.eq\("provider", providerId\)/,
    );
  });
});
