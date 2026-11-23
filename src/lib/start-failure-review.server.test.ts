import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reviewContradictedStartFailure } from "./start-failure-review.server.ts";

/**
 * MOCKED: the decision rules and the claim-then-apply order on a small
 * in-memory table that honours conditional updates. Concurrency against
 * PostgreSQL is in the local QA run (start-failure review section).
 */

type Row = Record<string, unknown>;
function memoryDb(tables: Record<string, Row[]>) {
  return {
    tables,
    from(table: string) {
      const filters: [string, unknown][] = [];
      let patch: Row | null = null;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => (filters.push([c, v]), b),
        update: (p: Row) => ((patch = p), b),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => void) => {
          const hit = rows();
          if (patch) for (const r of hit) Object.assign(r, patch);
          resolve({ data: hit.map((r) => ({ ...r })), error: null });
        },
      };
      return b;
    },
  };
}

const NOW = new Date("2026-11-23T10:00:00Z");
function setup(over: Row = {}, contactStatus = "outcome_unknown") {
  return memoryDb({
    call_logs: [
      {
        id: "call_1",
        organization_id: "org_1",
        provider: "sarvam",
        direction: "outbound",
        status: "failed",
        resolution_source: "start_failure",
        resolution_conflict: true,
        provider_metadata: { late_provider_report: { status: "completed", durationSeconds: 95 } },
        campaign_id: "camp_1",
        campaign_contact_id: "cc_1",
        ...over,
      },
    ],
    campaign_contacts: [
      { id: "cc_1", status: contactStatus, attempts: 1, current_call_id: "call_1" },
    ],
    campaigns: [
      { id: "camp_1", max_attempts: 3, retry_after_minutes: 60, retry_statuses: ["failed"] },
    ],
  });
}
const run = (db: ReturnType<typeof setup>, decision: string, allowRetry = false) =>
  reviewContradictedStartFailure(db as never, {
    callId: "call_1",
    decision: decision as never,
    allowRetry,
    reason: "checked Sarvam",
    reviewedBy: "admin_1",
    now: NOW,
  });
const call = (db: ReturnType<typeof setup>) => db.tables["call_logs"]![0]!;
const contact = (db: ReturnType<typeof setup>) => db.tables["campaign_contacts"]![0]!;

describe("reviewing a contradicted start failure", () => {
  test("call confirmed: the record keeps its outcome, leaves review, the contact takes the provider's final outcome", async () => {
    const db = setup();
    const r = await run(db, "call_confirmed");
    assert.equal(r.duplicate, false);
    assert.equal(call(db)["status"], "failed", "original outcome preserved, never billed");
    assert.equal(call(db)["resolution_conflict"], false);
    assert.equal(call(db)["resolved_by"], "admin_1");
    assert.deepEqual(contact(db)["status"], "completed");
    assert.equal(contact(db)["next_attempt_at"], null, "never redialled");
  });

  test("no call, retry NOT allowed: the contact ends failed, no retry", async () => {
    const db = setup();
    await run(db, "no_call_confirmed", false);
    assert.equal(contact(db)["status"], "failed");
    assert.equal(contact(db)["next_attempt_at"], null);
  });

  test("no call, retry explicitly allowed: the campaign's own retry policy decides", async () => {
    const db = setup();
    await run(db, "no_call_confirmed", true);
    assert.equal(contact(db)["status"], "retry_scheduled");
    assert.equal(contact(db)["next_attempt_at"], "2026-11-23T11:00:00.000Z");
  });

  test("unresolved: nothing changes; the call stays in review", async () => {
    const db = setup();
    const r = await run(db, "unresolved");
    assert.equal(r.applied, null);
    assert.equal(call(db)["resolution_conflict"], true);
    assert.equal(contact(db)["status"], "outcome_unknown");
  });

  test("a double click / retry: the first decision stands and nothing is applied twice", async () => {
    const db = setup();
    await run(db, "call_confirmed");
    const again = await run(db, "no_call_confirmed", true);
    assert.equal(again.duplicate, true);
    assert.equal(again.applied?.decision, "call_confirmed");
    assert.equal(contact(db)["status"], "completed", "the second decision never moves the contact");
  });

  test("crash after the call was claimed, before the contact moved: a retry repairs the contact", async () => {
    const db = setup();
    Object.assign(call(db), {
      resolution_conflict: false,
      provider_metadata: {
        ...(call(db)["provider_metadata"] as Row),
        operator_review: { decision: "no_call_confirmed", allowRetry: false, reason: "x" },
      },
    });
    const r = await run(db, "call_confirmed");
    assert.equal(r.duplicate, true);
    assert.equal(
      contact(db)["status"],
      "failed",
      "the stored decision is applied, not the new one",
    );
  });

  test("a contact already moved on (a later call) is never touched", async () => {
    const db = setup({}, "calling");
    contact(db)["current_call_id"] = "call_2";
    const r = await run(db, "no_call_confirmed", true);
    assert.equal(r.contact, null);
    assert.equal(contact(db)["status"], "calling");
  });

  test("only rejected-start calls can be reviewed here", async () => {
    const db = setup({ resolution_source: "provider" });
    await assert.rejects(run(db, "call_confirmed"), /rejected start/);
    const done = setup({ resolution_conflict: false });
    await assert.rejects(run(done, "unresolved"), /already reviewed/);
  });
});
