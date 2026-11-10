import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recordCampaignStartFailure } from "./sarvam-outbound-call.server.ts";
import { resolveUnknownSarvamCall } from "./sarvam-call-resolution.server.ts";
import { checkCallTransition, TERMINAL_CALL_STATUSES } from "./telephony-guard.server.ts";
import { checkClientReferenceMatch } from "./telephony/webhook-correlation.server.ts";
import { decideCampaignContactOutcome, type CallTerminalStatus } from "./campaign-outcome.ts";
import { TelephonyAdapterError, type NormalizedCallEvent } from "./telephony/adapter.ts";

/**
 * Race-order and billing-once coverage for outcome_unknown.
 *
 * Runs the REAL recordCampaignStartFailure and resolveUnknownSarvamCall
 * against a stateful in-memory database that honours conditional updates
 * (`.eq("status", ...)`) and the webhook_events unique key. The webhook
 * side is a model of src/routes/api/public/webhooks/telephony.ts (which
 * this repo's test runner cannot import), built from the same real helpers
 * it uses: webhook_events dedupe, provider_call_id lookup, the call_id
 * fallback via checkClientReferenceMatch with conditional backfill,
 * checkCallTransition, billing on terminal statuses, and the campaign
 * outcome rules. Billing is modelled as debit_wallet_for_call: idempotent
 * per call id (the SQL function checks for an existing debit under a row
 * lock), and the test counts how many times it actually charged.
 */

type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is" | "in"; val: unknown };

class MemoryDb {
  tables: Record<string, Row[]> = { call_logs: [], campaign_contacts: [], webhook_events: [] };
  /** Runs right after a successful update on `table` — used to interleave a webhook mid-handler. */
  afterUpdate: Partial<Record<string, () => Promise<void>>> = {};

  // An arrow property, so `this` inside the builder's arrow `then` is the database.
  from = (table: string) => {
    let op: "select" | "update" | "insert" | "delete" = "select";
    let payload: Row = {};
    let returnRows = false;
    let single = false;
    const filters: Filter[] = [];
    const matches = (r: Row) =>
      filters.every((f) =>
        f.op === "in" ? (f.val as unknown[]).includes(r[f.col]) : r[f.col] === f.val,
      );
    const builder = {
      select(_columns?: string) {
        if (op === "update") returnRows = true;
        return builder;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return builder;
      },
      insert(p: Row) {
        op = "insert";
        payload = p;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, op: "eq", val });
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push({ col, op: "is", val });
        return builder;
      },
      in(col: string, val: unknown[]) {
        filters.push({ col, op: "in", val });
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        single = true;
        return builder;
      },
      single() {
        single = true;
        return builder;
      },
      then: async (resolve: (r: { data: unknown; error: unknown }) => void) => {
        const rows = (this.tables[table] ??= []);
        if (op === "insert") {
          if (
            table === "webhook_events" &&
            rows.some(
              (r) => r["provider"] === payload["provider"] && r["event_id"] === payload["event_id"],
            )
          )
            return resolve({ data: null, error: { code: "23505", message: "duplicate" } });
          // idx_call_logs_sarvam_outbound_number_reservation (same predicate as the migration).
          const reserves = (r: Row) =>
            r["provider"] === "sarvam" &&
            r["direction"] === "outbound" &&
            r["destination_number"] != null &&
            ["initiated", "outcome_unknown"].includes(r["status"] as string);
          if (
            table === "call_logs" &&
            reserves(payload) &&
            rows.some(
              (r) =>
                reserves(r) &&
                r["organization_id"] === payload["organization_id"] &&
                r["destination_number"] === payload["destination_number"],
            )
          )
            return resolve({
              data: null,
              error: { code: "23505", message: "idx_call_logs_sarvam_outbound_number_reservation" },
            });
          const row = { id: randomUUID(), ...payload };
          rows.push(row);
          return resolve({ data: { ...row }, error: null });
        }
        if (op === "delete") {
          this.tables[table] = rows.filter((r) => !matches(r));
          return resolve({ data: null, error: null });
        }
        const hit = rows.filter(matches);
        if (op === "update") {
          for (const r of hit) Object.assign(r, payload);
          if (hit.length > 0) await this.afterUpdate[table]?.();
          return resolve({
            data: returnRows ? hit.map((r) => ({ id: r["id"] })) : null,
            error: null,
          });
        }
        return resolve({ data: single ? (hit[0] ? { ...hit[0] } : null) : hit, error: null });
      },
    };
    return builder;
  };

  call(id: string) {
    return this.tables["call_logs"]!.find((r) => r["id"] === id)!;
  }
  contact(id: string) {
    return this.tables["campaign_contacts"]!.find((r) => r["id"] === id)!;
  }
}

const CALL_ID = "8f14e45f-ceea-467e-a4a9-1c1c1c1c1c1c";
const POLICY = {
  maxAttempts: 3,
  retryAfterMinutes: 60,
  retryStatuses: ["no_answer", "busy", "failed"],
};

function setup() {
  const db = new MemoryDb();
  db.tables["call_logs"]!.push({
    id: CALL_ID,
    organization_id: "org_1",
    provider: "sarvam",
    direction: "outbound",
    status: "initiated",
    provider_call_id: null,
    campaign_id: "camp_1",
    campaign_contact_id: "cc_1",
  });
  db.tables["campaign_contacts"]!.push({ id: "cc_1", status: "calling", attempts: 1 });
  const charges: { callId: string; seconds: number }[] = [];
  const debited = new Set<string>();
  return { db, charges, debited };
}

/** Model of the webhook route's processTelephonyEvent + applyCallEvent for a Sarvam outbound event. */
async function applyEvent(
  env: ReturnType<typeof setup>,
  event: NormalizedCallEvent,
  options: { onlyCallId?: string } = {},
) {
  const { db } = env;
  let row = db.tables["call_logs"]!.find((r) => r["provider_call_id"] === event.providerCallId);
  if (row && options.onlyCallId && row["id"] !== options.onlyCallId) return;
  if (!row) {
    row = db.tables["call_logs"]!.find((r) => r["id"] === event.clientReference);
    if (!row) return;
    if (options.onlyCallId && row["id"] !== options.onlyCallId) return;
    const match = checkClientReferenceMatch(
      row as { organization_id: string; provider_call_id: string | null },
      event,
    );
    if (!match.ok) return;
    if (match.backfillProviderCallId && row["provider_call_id"] === null)
      row["provider_call_id"] = event.providerCallId;
  }
  // applyCallEvent works on the row it read; the write happens after an await.
  const t = checkCallTransition(row["status"] as string, event.status);
  if (!t.ok || !t.changed) return;
  await Promise.resolve();
  // The real update is `.not("status", "in", TERMINAL_CALL_STATUSES)`: it never overwrites a final status.
  if (TERMINAL_CALL_STATUSES.includes(row["status"] as never)) return;
  row["status"] = event.status;
  if (TERMINAL_CALL_STATUSES.includes(event.status)) {
    // debit_wallet_for_call: idempotent per call.
    if (!env.debited.has(row["id"] as string)) {
      env.debited.add(row["id"] as string);
      env.charges.push({ callId: row["id"] as string, seconds: event.durationSeconds ?? 0 });
    }
    // Like applyCallEvent: the campaign outcome only runs for a campaign call.
    if (row["campaign_contact_id"]) {
      const cc = db.contact(row["campaign_contact_id"] as string);
      const decision = decideCampaignContactOutcome(
        event.status as CallTerminalStatus,
        cc["attempts"] as number,
        POLICY,
        null,
      );
      cc["status"] = decision.status;
    }
  }
}

/** Model of handleTelephonyWebhook: dedupe on webhook_events, then process. */
async function deliverWebhook(env: ReturnType<typeof setup>, event: NormalizedCallEvent) {
  const { error } = await env.db
    .from("webhook_events")
    .insert({ provider: "sarvam", event_id: event.eventId! });
  if (error) return "duplicate";
  await applyEvent(env, event);
  return "processed";
}

const connected = (attempt = "att_1"): NormalizedCallEvent => ({
  eventId: attempt,
  providerCallId: attempt,
  status: "completed",
  direction: "outbound",
  durationSeconds: 61,
  recordingUrl: null,
  failureReason: null,
  occurredAt: new Date().toISOString(),
  clientReference: CALL_ID,
  metadataOrganizationId: "org_1",
  raw: {},
});
const timeout = () =>
  new TelephonyAdapterError("Sarvam did not respond in time. Please retry.", 503, true);
const rejected = () => new TelephonyAdapterError("Sarvam rejected the request as invalid.", 400);

async function startFailure(env: ReturnType<typeof setup>, err: unknown) {
  let definiteFailures = 0;
  const outcome = await recordCampaignStartFailure(
    env.db as never,
    { callId: CALL_ID, campaignContactId: "cc_1" },
    err,
    async () => {
      definiteFailures++;
    },
  );
  return { outcome, definiteFailures };
}

describe("race order 1: webhook completes the call first, then the timeout handler runs", () => {
  test("the timeout handler changes nothing and the call is billed once", async () => {
    const env = setup();
    assert.equal(await deliverWebhook(env, connected()), "processed");
    const { outcome, definiteFailures } = await startFailure(env, timeout());

    assert.equal(outcome, "superseded");
    assert.equal(definiteFailures, 0);
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.equal(env.db.call(CALL_ID)["provider_call_id"], "att_1");
    assert.equal(env.db.contact("cc_1")["status"], "completed");
    assert.deepEqual(env.charges, [{ callId: CALL_ID, seconds: 61 }]);
  });

  test("a definite start error arriving late is also ignored (no failed, no campaign retry)", async () => {
    const env = setup();
    await deliverWebhook(env, connected());
    const { outcome, definiteFailures } = await startFailure(env, rejected());
    assert.equal(outcome, "superseded");
    assert.equal(definiteFailures, 0);
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.equal(env.charges.length, 1);
  });
});

describe("race order 2: timeout marks the call unknown first, then the webhook completes it", () => {
  test("call and contact are held unknown, then the webhook resolves both and bills once", async () => {
    const env = setup();
    const { outcome } = await startFailure(env, timeout());
    assert.equal(outcome, "outcome_unknown");
    assert.equal(env.db.call(CALL_ID)["status"], "outcome_unknown");
    assert.equal(env.db.contact("cc_1")["status"], "outcome_unknown");
    assert.equal(env.charges.length, 0);

    assert.equal(await deliverWebhook(env, connected()), "processed");
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.equal(env.db.call(CALL_ID)["provider_call_id"], "att_1");
    assert.equal(env.db.contact("cc_1")["status"], "completed");

    assert.equal(await deliverWebhook(env, connected()), "duplicate");
    assert.deepEqual(env.charges, [{ callId: CALL_ID, seconds: 61 }]);
  });

  test("a webhook landing between the call update and the contact update keeps its contact outcome", async () => {
    const env = setup();
    env.db.afterUpdate["call_logs"] = async () => {
      env.db.afterUpdate["call_logs"] = undefined;
      await deliverWebhook(env, connected());
    };
    const { outcome } = await startFailure(env, timeout());
    assert.equal(outcome, "outcome_unknown");
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.equal(
      env.db.contact("cc_1")["status"],
      "completed",
      "contact update was conditional on `calling`",
    );
    assert.equal(env.charges.length, 1);
  });
});

describe("definite failures and claims", () => {
  test("a definite rejection fails the call and runs the campaign outcome exactly once", async () => {
    const env = setup();
    const { outcome, definiteFailures } = await startFailure(env, rejected());
    assert.equal(outcome, "failed");
    assert.equal(definiteFailures, 1);
    assert.equal(env.db.call(CALL_ID)["status"], "failed");
  });

  test("an outcome_unknown contact cannot be claimed by the dispatcher's claim query", async () => {
    const env = setup();
    await startFailure(env, timeout());
    const { data } = await env.db
      .from("campaign_contacts")
      .update({ status: "calling" })
      .eq("id", "cc_1")
      .in("status", ["pending", "retry_scheduled"])
      .select("id");
    assert.deepEqual(data, []);
    assert.equal(env.db.contact("cc_1")["status"], "outcome_unknown");
  });

  test("transitions: outcome_unknown resolves only to a final status; final statuses stay final", () => {
    for (const s of ["completed", "failed", "busy", "no_answer", "cancelled"] as const)
      assert.deepEqual(checkCallTransition("outcome_unknown", s), { ok: true, changed: true });
    for (const s of ["ringing", "answered", "in_progress", "initiated"] as const)
      assert.equal(checkCallTransition("outcome_unknown", s).ok, false);
    assert.equal(checkCallTransition("completed", "failed").ok, false);
  });
});

describe("operator resolution", () => {
  const deps = (env: ReturnType<typeof setup>, campaignFailures: string[] = []) => ({
    processEvent: (event: NormalizedCallEvent, options: { onlyCallId: string }) =>
      applyEvent(env, event, options),
    // Stands in for finalizeTerminalCall (exercised in call-finalization tests
    // and against PostgreSQL): records that finalization ran for the call.
    finalize: async (callId: string) => {
      campaignFailures.push(callId);
      if (env.db.call(callId)["status"] === "failed")
        env.db.contact("cc_1")["status"] = "retry_scheduled";
      return { state: "done" as const };
    },
  });

  test("not placed: fails the call and runs the campaign failure once", async () => {
    const env = setup();
    await startFailure(env, timeout());
    const failures: string[] = [];
    const result = await resolveUnknownSarvamCall(
      env.db as never,
      { callId: CALL_ID, resolution: "not_placed" },
      deps(env, failures),
    );
    assert.equal(result.status, "failed");
    assert.equal(env.db.call(CALL_ID)["status"], "failed");
    assert.deepEqual(failures, [CALL_ID]);
    assert.equal(env.charges.length, 0);
  });

  test("placed + connected bills once; the real webhook arriving later is rejected", async () => {
    const env = setup();
    await startFailure(env, timeout());
    await resolveUnknownSarvamCall(
      env.db as never,
      { callId: CALL_ID, resolution: "placed", outcome: "completed", durationSeconds: 90 },
      deps(env),
    );
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.equal(env.db.call(CALL_ID)["provider_call_id"], `manual:${CALL_ID}`);

    // Real webhook for the unknown attempt: matched by call_id, but the row is
    // bound to the operator's key, so checkClientReferenceMatch rejects it.
    assert.equal(await deliverWebhook(env, connected("att_real")), "processed");
    assert.deepEqual(env.charges, [{ callId: CALL_ID, seconds: 90 }]);
  });

  test("placed with the attempt id: a later webhook for that attempt is deduplicated", async () => {
    const env = setup();
    await startFailure(env, timeout());
    await resolveUnknownSarvamCall(
      env.db as never,
      { callId: CALL_ID, resolution: "placed", outcome: "no_answer", attemptId: "att_9" },
      deps(env),
    );
    assert.equal(await deliverWebhook(env, connected("att_9")), "duplicate");
    assert.deepEqual(env.charges, [{ callId: CALL_ID, seconds: 0 }]);
    assert.equal(env.db.call(CALL_ID)["status"], "no_answer");
  });

  test("a call a webhook resolved first can't be resolved again, and nothing is charged twice", async () => {
    const env = setup();
    await startFailure(env, timeout());
    await deliverWebhook(env, connected());
    await assert.rejects(
      resolveUnknownSarvamCall(
        env.db as never,
        { callId: CALL_ID, resolution: "not_placed" },
        deps(env),
      ),
      /doesn't need resolving/,
    );
    assert.equal(env.charges.length, 1);
  });

  test("not placed loses a race with a concurrent webhook: nothing changes, no campaign failure", async () => {
    const env = setup();
    await startFailure(env, timeout());
    const failures: string[] = [];
    // The webhook lands after the resolver read the row, before its conditional update.
    const realFrom = env.db.from.bind(env.db);
    let injected = false;
    env.db.from = (table: string) => {
      if (table === "call_logs" && !injected) {
        injected = true;
        const b = realFrom(table);
        const realThen = b.then.bind(b);
        b.then = async (resolve) => {
          let read: { data: unknown; error: unknown } = { data: null, error: null };
          await realThen((r) => {
            read = r;
          });
          await deliverWebhook(env, connected()); // fully applied before the resolver sees its read
          resolve(read);
        };
        return b;
      }
      return realFrom(table);
    };
    await assert.rejects(
      resolveUnknownSarvamCall(
        env.db as never,
        { callId: CALL_ID, resolution: "not_placed" },
        deps(env, failures),
      ),
      /changed while you were resolving/,
    );
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.deepEqual(failures, []);
    assert.equal(env.charges.length, 1);
  });

  test("if processing throws, the operator's dedupe row is released for a retry", async () => {
    const env = setup();
    await startFailure(env, timeout());
    await assert.rejects(
      resolveUnknownSarvamCall(
        env.db as never,
        { callId: CALL_ID, resolution: "placed", outcome: "completed", durationSeconds: 5 },
        { ...deps(env), processEvent: async () => Promise.reject(new Error("boom")) },
      ),
      /boom/,
    );
    assert.equal(env.db.tables["webhook_events"]!.length, 0);
  });
});

describe("source checks", () => {
  const read = (rel: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8");

  test("dispatcher routes start failures through the race-safe helper and never fails them directly", () => {
    const dispatch = read("campaign-dispatch.server.ts");
    assert.match(dispatch, /recordCampaignStartFailure\(/);
    assert.doesNotMatch(dispatch, /update\(\{ status: "failed"/);
    // Only pending/retry_scheduled can be claimed, only at the attempt count this
    // run read, and the claim records the call it is for.
    assert.match(
      dispatch,
      /\.update\(\{ status: "calling", attempts, current_call_id: callId \}\)\s*\.eq\("id", cc\.id\)\s*\.in\("status", \["pending", "retry_scheduled"\]\)\s*\.eq\("attempts", cc\.attempts\)/,
    );
  });

  test("a campaign with outcome_unknown contacts does not complete", () => {
    assert.match(
      read("campaign-dispatch.server.ts"),
      /"pending", "retry_scheduled", "queued", "calling", "outcome_unknown"/,
    );
  });

  test("migration adds outcome_unknown to both CHECK lists and keeps every existing value", () => {
    const sql = read("../../supabase/migrations/20261109090000_outbound_call_outcome_unknown.sql");
    assert.match(
      sql,
      /call_logs_status_check\s+CHECK \(status IN \('initiated', 'ringing', 'answered', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'cancelled', 'outcome_unknown'\)\)/,
    );
    assert.match(
      sql,
      /'pending','queued','calling','connected','no_answer','busy','failed',\s*'completed','retry_scheduled','opted_out','wrong_number','cancelled','outcome_unknown'/,
    );
    assert.doesNotMatch(sql, /DROP (TABLE|COLUMN|INDEX)/i);
  });
});

describe("resolving an initiated call with a known attempt id (accepted, webhook never arrived)", () => {
  const initiatedWithAttempt = () => {
    const env = setup();
    env.db.call(CALL_ID)["provider_call_id"] = "att_1";
    return env;
  };
  const deps = (env: ReturnType<typeof setup>, failures: string[] = []) => ({
    processEvent: (event: NormalizedCallEvent, options: { onlyCallId: string }) =>
      applyEvent(env, event, options),
    finalize: async (callId: string) => {
      if (env.db.call(callId)["status"] === "failed") failures.push(callId);
      return { state: "done" as const };
    },
  });

  test("placed + connected bills once; the late real webhook for that attempt is deduplicated", async () => {
    const env = initiatedWithAttempt();
    await resolveUnknownSarvamCall(
      env.db as never,
      {
        callId: CALL_ID,
        resolution: "placed",
        outcome: "completed",
        durationSeconds: 70,
        confirmedCheckedInSarvam: true,
      },
      deps(env),
    );
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.equal(await deliverWebhook(env, connected("att_1")), "duplicate");
    assert.deepEqual(env.charges, [{ callId: CALL_ID, seconds: 70 }]);
    assert.equal(env.db.contact("cc_1")["status"], "completed");
  });

  test("a webhook racing the resolution: exactly one applies, billed once, no overwrite", async () => {
    const env = initiatedWithAttempt();
    const [resolution, webhook] = await Promise.allSettled([
      resolveUnknownSarvamCall(
        env.db as never,
        {
          callId: CALL_ID,
          resolution: "placed",
          outcome: "no_answer",
          confirmedCheckedInSarvam: true,
        },
        deps(env),
      ),
      deliverWebhook(env, connected("att_1")),
    ]);
    const final = env.db.call(CALL_ID)["status"];
    assert.ok(final === "completed" || final === "no_answer");
    assert.equal(env.charges.length, 1);
    // Whoever lost the shared att_1 dedupe key changed nothing.
    if (final === "completed") assert.equal(resolution.status, "rejected");
    else assert.deepEqual(webhook, { status: "fulfilled", value: "duplicate" });
  });

  test("not placed loses to a webhook that lands mid-resolution: no change, no campaign failure", async () => {
    const env = initiatedWithAttempt();
    const failures: string[] = [];
    const realFrom = env.db.from;
    let injected = false;
    env.db.from = (table: string) => {
      const b = realFrom(table);
      if (table === "call_logs" && !injected) {
        injected = true;
        const realThen = b.then;
        b.then = async (resolve) => {
          let read: { data: unknown; error: unknown } = { data: null, error: null };
          await realThen((r) => {
            read = r;
          });
          await deliverWebhook(env, connected("att_1"));
          resolve(read);
        };
      }
      return b;
    };
    await assert.rejects(
      resolveUnknownSarvamCall(
        env.db as never,
        { callId: CALL_ID, resolution: "not_placed", confirmedCheckedInSarvam: true },
        deps(env, failures),
      ),
      /changed while you were resolving/,
    );
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.deepEqual(failures, []);
    assert.equal(env.charges.length, 1);
  });

  test("a different attempt id than the one recorded is refused", async () => {
    const env = initiatedWithAttempt();
    await assert.rejects(
      resolveUnknownSarvamCall(
        env.db as never,
        {
          callId: CALL_ID,
          resolution: "placed",
          outcome: "completed",
          attemptId: "att_typo",
          confirmedCheckedInSarvam: true,
        },
        deps(env),
      ),
      /doesn't match/,
    );
    assert.equal(env.db.tables["webhook_events"]!.length, 0);
  });
});

describe("tenant safety of operator resolution", () => {
  test("an attempt id recorded on another call (another tenant) is refused before anything is written", async () => {
    const env = setup();
    await startFailure(env, timeout());
    env.db.tables["call_logs"]!.push({
      id: "other-call",
      organization_id: "org_2",
      provider: "sarvam",
      direction: "outbound",
      status: "initiated",
      provider_call_id: "att_other",
      campaign_id: null,
      campaign_contact_id: null,
    });
    await assert.rejects(
      resolveUnknownSarvamCall(
        env.db as never,
        { callId: CALL_ID, resolution: "placed", outcome: "completed", attemptId: "att_other" },
        {
          processEvent: (e, o) => applyEvent(env, e, o),
          finalize: async () => ({ state: "done" as const }),
        },
      ),
      /belongs to a different call/,
    );
    assert.equal(env.db.tables["webhook_events"]!.length, 0);
    assert.equal(env.db.call("other-call")["status"], "initiated");
    assert.equal(env.db.call(CALL_ID)["status"], "outcome_unknown");
    assert.equal(env.charges.length, 0);
  });

  test("operator events are pinned to the call being resolved", async () => {
    const env = setup();
    await startFailure(env, timeout());
    const seen: { onlyCallId: string }[] = [];
    await resolveUnknownSarvamCall(
      env.db as never,
      { callId: CALL_ID, resolution: "placed", outcome: "busy" },
      {
        processEvent: async (e, o) => {
          seen.push(o);
          await applyEvent(env, e, o);
        },
        finalize: async () => ({ state: "done" as const }),
      },
    );
    assert.deepEqual(seen, [{ onlyCallId: CALL_ID }]);
  });

  test("a pinned event that would land on a different call changes nothing", async () => {
    const env = setup();
    env.db.call(CALL_ID)["provider_call_id"] = "att_1";
    await applyEvent(env, connected("att_1"), { onlyCallId: "some-other-call" });
    assert.equal(env.db.call(CALL_ID)["status"], "initiated");
    assert.equal(env.charges.length, 0);
  });

  test("two events applied concurrently to one call: the final status is never overwritten, billed once", async () => {
    const env = setup();
    env.db.call(CALL_ID)["provider_call_id"] = "att_1";
    const failed = { ...connected("att_1"), status: "failed" as const, durationSeconds: undefined };
    await Promise.all([applyEvent(env, connected("att_1")), applyEvent(env, failed)]);
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.deepEqual(env.charges, [{ callId: CALL_ID, seconds: 61 }]);
  });
});

describe("shared rules and wiring", () => {
  test("isResolvableSarvamCall: every unresolved Sarvam outbound call, with or without an attempt id", async () => {
    const { isResolvableSarvamCall } = await import("./sarvam-call-review.ts");
    const sarvamOut = { provider: "sarvam", direction: "outbound" };
    const ok = (status: string, base = sarvamOut) => isResolvableSarvamCall({ ...base, status });
    assert.equal(ok("outcome_unknown"), true);
    assert.equal(ok("initiated"), true);
    assert.equal(ok("completed"), false);
    assert.equal(ok("failed"), false);
    assert.equal(ok("outcome_unknown", { provider: "vobiz", direction: "outbound" }), false);
    assert.equal(ok("initiated", { provider: "sarvam", direction: "inbound" }), false);
  });

  const read = (rel: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8").replace(/\r\n/g, "\n");
  const shared = read("telephony/telephony-event-processing.server.ts");

  test("the shared processor never overwrites a final status and stops before billing when it can't write", () => {
    const update = shared.slice(shared.indexOf(".update(patch as never)"));
    assert.ok(
      update.includes('.not("status", "in", `(${TERMINAL_CALL_STATUSES.join(",")})`)'),
      "update is conditional on the call not being final",
    );
    const guard = update.indexOf("if (!updated || updated.length === 0) {");
    assert.ok(guard > -1 && guard < update.indexOf("finalizeCallBilling("));
  });

  test("the shared processor honours onlyCallId on both paths and never inserts for a targeted event", () => {
    assert.match(
      shared,
      /if \(existingCall\) \{\s*if \(!isTargetCall\(existingCall\.id\)\) return;/,
    );
    assert.match(
      shared,
      /if \(!isTargetCall\(resolved\.id\)\) return;\s*const match = checkClientReferenceMatch/,
    );
    const targetedReturn = shared.indexOf("if (options.onlyCallId) return;");
    assert.ok(targetedReturn > -1 && targetedReturn < shared.indexOf("const destinationNumber ="));
  });

  test("route, vobiz-answer and operator resolution all use the shared module; nothing imports the route", () => {
    for (const rel of [
      "../routes/api/public/webhooks/telephony.ts",
      "../routes/api/public/webhooks/vobiz-answer.ts",
    ])
      assert.match(read(rel), /@\/lib\/telephony\/telephony-event-processing\.server/);
    assert.match(
      read("sarvam-call-resolution.server.ts"),
      /\.\/telephony\/telephony-event-processing\.server\.ts/,
    );
    assert.doesNotMatch(read("sarvam-admin.functions.ts"), /routes\/api\/public\/webhooks/);
  });

  test("the admin resolve action requires numbers.write and writes an audit entry", () => {
    const admin = read("sarvam-admin.functions.ts");
    const fn = admin.slice(admin.indexOf("export const resolveUnknownSarvamCall"));
    const gate = fn.indexOf(
      'assertPlatformAdmin(context.supabase, context.userId, "numbers.write")',
    );
    assert.ok(gate > -1 && gate < fn.indexOf("await resolve("));
    assert.match(fn, /writeAudit\(admin, \{\s*action: "SARVAM_CALL_OUTCOME_RESOLVED"/);
  });
});

describe("operator dedupe row, webhook duplicate, then operator failure", () => {
  const confirmed = { confirmedCheckedInSarvam: true } as const;

  for (const scenario of [
    "initiated with a known attempt id",
    "outcome_unknown, attempt id typed in",
  ]) {
    test(`${scenario}: the call stays recoverable and a retry bills exactly once`, async () => {
      const env = setup();
      let input: Parameters<typeof resolveUnknownSarvamCall>[1];
      if (scenario.startsWith("initiated")) {
        env.db.call(CALL_ID)["provider_call_id"] = "att_1";
        input = {
          callId: CALL_ID,
          resolution: "placed",
          outcome: "completed",
          durationSeconds: 61,
          ...confirmed,
        };
      } else {
        await startFailure(env, timeout());
        input = {
          callId: CALL_ID,
          resolution: "placed",
          outcome: "completed",
          durationSeconds: 61,
          attemptId: "att_1",
        };
      }
      const before = env.db.call(CALL_ID)["status"];

      // 1. The operator has inserted the att_1 dedupe row; 2. the real webhook
      // for att_1 arrives and is discarded as a duplicate; 3. the operator's
      // processing then fails.
      let webhookResult: string | undefined;
      await assert.rejects(
        resolveUnknownSarvamCall(env.db as never, input, {
          processEvent: async () => {
            assert.equal(
              env.db.tables["webhook_events"]!.length,
              1,
              "operator's dedupe row exists",
            );
            webhookResult = await deliverWebhook(env, connected("att_1"));
            throw new Error("processing failed");
          },
          finalize: async () => ({ state: "done" as const }),
        }),
        /processing failed/,
      );
      assert.equal(webhookResult, "duplicate");

      // Recoverable: unchanged, nothing billed, dedupe row released.
      assert.equal(env.db.call(CALL_ID)["status"], before);
      assert.equal(env.db.tables["webhook_events"]!.length, 0);
      assert.equal(env.charges.length, 0);

      // A second resolution succeeds and bills once.
      await resolveUnknownSarvamCall(env.db as never, input, {
        processEvent: (e, o) => applyEvent(env, e, o),
        finalize: async () => ({ state: "done" as const }),
      });
      assert.equal(env.db.call(CALL_ID)["status"], "completed");
      assert.deepEqual(env.charges, [{ callId: CALL_ID, seconds: 61 }]);

      // Any later delivery of the same attempt is a duplicate; still billed once.
      assert.equal(await deliverWebhook(env, connected("att_1")), "duplicate");
      assert.equal(env.charges.length, 1);
    });
  }
});

describe("resolving a call that may still be active", () => {
  const initiatedWithAttempt = () => {
    const env = setup();
    env.db.call(CALL_ID)["provider_call_id"] = "att_1";
    return env;
  };
  const noop = { finalize: async () => ({ state: "done" as const }) };

  test("an initiated call can't be resolved without confirming it was checked in Sarvam — nothing is written", async () => {
    const env = initiatedWithAttempt();
    let processed = false;
    for (const resolution of ["not_placed", "placed"] as const) {
      await assert.rejects(
        resolveUnknownSarvamCall(
          env.db as never,
          { callId: CALL_ID, resolution, outcome: "completed", durationSeconds: 61 },
          { ...noop, processEvent: async () => void (processed = true) },
        ),
        /Confirm you checked its status in Sarvam/,
      );
    }
    assert.equal(processed, false);
    assert.equal(env.db.call(CALL_ID)["status"], "initiated");
    assert.equal(env.db.tables["webhook_events"]!.length, 0);
  });

  test("outcome_unknown calls don't need the confirmation (Sarvam never accepted them)", async () => {
    const env = setup();
    await startFailure(env, timeout());
    const result = await resolveUnknownSarvamCall(
      env.db as never,
      { callId: CALL_ID, resolution: "not_placed" },
      noop,
    );
    assert.equal(result.status, "failed");
  });

  test("'not placed' schedules a campaign retry only after the campaign's retry delay, never immediately", () => {
    const now = new Date("2026-11-09T10:00:00Z");
    const decision = decideCampaignContactOutcome("failed", 1, POLICY, null, now);
    assert.equal(decision.status, "retry_scheduled");
    assert.equal(
      new Date(decision.nextAttemptAt!).getTime() - now.getTime(),
      POLICY.retryAfterMinutes * 60_000,
    );
  });

  test("while unresolved, the campaign contact can't be re-dialled (the in-flight call row still blocks it)", async () => {
    const env = initiatedWithAttempt();
    // The dispatcher only claims pending/retry_scheduled contacts; this one is still `calling`.
    const { data } = await env.db
      .from("campaign_contacts")
      .update({ status: "calling" })
      .eq("id", "cc_1")
      .in("status", ["pending", "retry_scheduled"])
      .select("id");
    assert.deepEqual(data, []);
  });

  test("a call that really was still live, wrongly resolved as 'not placed': its late webhook is ignored and not billed", async () => {
    // Documents the residual risk the confirmation step guards against.
    const env = initiatedWithAttempt();
    await resolveUnknownSarvamCall(
      env.db as never,
      { callId: CALL_ID, resolution: "not_placed", confirmedCheckedInSarvam: true },
      noop,
    );
    assert.equal(await deliverWebhook(env, connected("att_1")), "processed");
    assert.equal(env.db.call(CALL_ID)["status"], "failed", "a final status is never overwritten");
    assert.equal(env.charges.length, 0);
  });
});

describe("one definition of 'needs resolving'", () => {
  const read = (rel: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8");
  test("the redial guard, the 'Needs review' list and the reservation index use the same statuses", async () => {
    const { UNRESOLVED_SARVAM_STATUSES } = await import("./sarvam-call-review.ts");
    assert.deepEqual([...UNRESOLVED_SARVAM_STATUSES], ["initiated", "outcome_unknown"]);
    const filter = '.in("status", [...UNRESOLVED_SARVAM_STATUSES])';
    assert.ok(read("sarvam-outbound-call.server.ts").includes(filter));
    assert.ok(
      read("telephony-admin.functions.ts").includes(
        'status.in.(${UNRESOLVED_SARVAM_STATUSES.join(",")})',
      ),
    );
    assert.match(
      read("../../supabase/migrations/20261109090000_outbound_call_outcome_unknown.sql"),
      /idx_call_logs_sarvam_outbound_number_reservation[\s\S]*status IN \('initiated', 'outcome_unknown'\)/,
    );
  });

  test("the admin action forwards and audits the Sarvam-check confirmation", () => {
    const admin = read("sarvam-admin.functions.ts");
    const fn = admin.slice(admin.indexOf("export const resolveUnknownSarvamCall"));
    assert.match(
      fn,
      /confirmedCheckedInSarvam: data\.confirmedCheckedInSarvam === true,\s*resolvedBy: admin\.userId,\s*\},?\s*\);/,
    );
    assert.match(
      fn,
      /newValue: \{[^}]*confirmedCheckedInSarvam: data\.confirmedCheckedInSarvam === true/,
    );
  });

  test("the dialog warns about live calls and requires the confirmation before sending", () => {
    const page = read("../routes/admin.calls.tsx");
    assert.match(page, /This call may still be in progress/);
    assert.match(page, /if \(mayBeActive && !checkedInSarvam\)\s*throw new Error/);
    assert.match(page, /a campaign may call this contact again/);
  });

  test("after resolving, success is only shown when billing and the campaign update finished", async () => {
    const { describeResolutionResult } = await import("./sarvam-call-review.ts");
    assert.deepEqual(describeResolutionResult({ status: "failed", finalization: "done" }), {
      tone: "success",
      title: "Call resolved",
      description: "Recorded as failed. Billing and campaign update finished.",
    });
    const failed = describeResolutionResult({ status: "no_answer", finalization: "failed" });
    assert.equal(failed.tone, "warning");
    assert.match(failed.title, /billing\/campaign update failed/);
    assert.match(failed.description, /^Recorded as no answer\./);
    assert.match(failed.description, /use Retry/);
    const pending = describeResolutionResult({ status: "completed", finalization: "skipped" });
    assert.equal(pending.tone, "warning");
    assert.match(pending.title, /still pending/);

    const page = read("../routes/admin.calls.tsx");
    assert.doesNotMatch(page, /toast\.success\("Call resolved"\)/);
    assert.match(page, /const result = await resolveCall\(/);
    assert.match(
      page,
      /const message = describeResolutionResult\(result\);\s*if \(message\.tone === "success"\)\s*toast\.success\(message\.title, \{ description: message\.description \}\);\s*else toast\.warning\(message\.title, \{ description: message\.description \}\);/,
    );
  });

  test("a call whose finalization is pending or failed shows its state, its error and Retry", () => {
    const page = read("../routes/admin.calls.tsx");
    const row = page.slice(page.indexOf("{needsFinalizationRetry(c) && ("));
    const end = row.indexOf("{c.resolutionConflict && (");
    const block = row.slice(0, end);
    assert.match(block, /"Billing\/campaign update failed"/);
    assert.match(block, /"Billing\/campaign update pending"/);
    assert.match(block, /onClick=\{\(\) => setFinalizing\(c\)\}/);
    assert.match(block, /Error: \{c\.finalizationError\}/);
  });
});

describe("single-call number reservation (concurrent requests and crash recovery)", () => {
  const ORG_ID = "org_1";
  const TO = "+912222222222";

  /** A database with one Sarvam number ready to dial, plus the real reservation index. */
  function dialSetup() {
    const env = setup();
    env.db.tables["call_logs"] = [];
    env.db.tables["phone_numbers"] = [
      {
        id: "num_1",
        e164: "+911111111111",
        organization_id: ORG_ID,
        provider: "sarvam",
        connection_id: "conn_1",
        agent_config_id: "agent_1",
      },
    ];
    env.db.tables["telephony_connections"] = [
      { id: "conn_1", provider: "sarvam", provider_connection_id: "sarvam_conn_1" },
    ];
    env.db.tables["agent_configs"] = [
      { id: "agent_1", organization_id: ORG_ID, sarvam_app_id: "app_1", sarvam_app_version: 2 },
    ];
    return env;
  }

  /** Runs `fn` with Sarvam configured and a fake Sarvam API that counts the calls it receives. */
  async function withSarvam<T>(fn: (dials: { count: number }) => Promise<T>): Promise<T> {
    const keys = [
      "SARVAM_API_KEY",
      "SARVAM_ORG_ID",
      "SARVAM_WORKSPACE_ID",
      "TELEPHONY_WEBHOOK_BASE_URL",
    ];
    const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      SARVAM_API_KEY: "sk_test",
      SARVAM_ORG_ID: "o",
      SARVAM_WORKSPACE_ID: "w",
      TELEPHONY_WEBHOOK_BASE_URL: "https://clickai.test",
    });
    const originalFetch = globalThis.fetch;
    const dials = { count: 0 };
    globalThis.fetch = (async () => {
      dials.count++;
      await new Promise((r) => setTimeout(r, 5)); // Sarvam takes a moment to answer
      return new Response(JSON.stringify({ attempt_id: `att_${dials.count}` }), { status: 200 });
    }) as typeof fetch;
    try {
      return await fn(dials);
    } finally {
      globalThis.fetch = originalFetch;
      for (const k of keys) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    }
  }

  const send = async (env: ReturnType<typeof setup>, to = TO) => {
    const { sendSarvamInstantOutboundCall } = await import("./sarvam-outbound-call.server.ts");
    return sendSarvamInstantOutboundCall(env.db as never, { phoneNumberId: "num_1", toE164: to });
  };

  test("two concurrent requests to the same number: exactly one is dialled, even before attempt_id is saved", async () => {
    const env = dialSetup();
    await withSarvam(async (dials) => {
      // Both pass the read-only pre-check before either inserts; the reservation index decides.
      const results = await Promise.allSettled([send(env), send(env)]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      assert.equal(won.length, 1);
      assert.equal(lost.length, 1);
      assert.match(
        String((lost[0] as PromiseRejectedResult).reason),
        /hasn't finished or has an unconfirmed outcome/,
      );
      assert.equal(dials.count, 1, "Sarvam was asked to place exactly one call");
      assert.equal(env.db.tables["call_logs"]!.length, 1);
    });
  });

  test("ten concurrent requests to the same number: still exactly one call", async () => {
    const env = dialSetup();
    await withSarvam(async (dials) => {
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => send(env)));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(dials.count, 1);
    });
  });

  test("different numbers, or the same number in another organization, are not blocked", async () => {
    const env = dialSetup();
    env.db.tables["call_logs"]!.push({
      id: "other-org-call",
      organization_id: "org_2",
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "initiated",
      provider_call_id: null,
      campaign_contact_id: null,
    });
    await withSarvam(async (dials) => {
      await Promise.all([send(env, TO), send(env, "+913333333333")]);
      assert.equal(dials.count, 2);
    });
  });

  test("crash before Sarvam answered: the number stays blocked until an operator resolves it, then calling works", async () => {
    const env = dialSetup();
    // The row as a crashed request leaves it: initiated, no attempt id.
    env.db.tables["call_logs"]!.push({
      id: CALL_ID,
      organization_id: ORG_ID,
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "initiated",
      provider_call_id: null,
      campaign_id: null,
      campaign_contact_id: null,
    });
    const { isResolvableSarvamCall } = await import("./sarvam-call-review.ts");
    assert.equal(
      isResolvableSarvamCall(env.db.call(CALL_ID) as never),
      true,
      "shows in Needs review",
    );

    await withSarvam(async (dials) => {
      await assert.rejects(send(env), /hasn't finished/);
      assert.equal(dials.count, 0);

      // Nothing resolves it automatically; the operator must confirm they checked Sarvam.
      const noop = { finalize: async () => ({ state: "done" as const }) };
      await assert.rejects(
        resolveUnknownSarvamCall(
          env.db as never,
          { callId: CALL_ID, resolution: "not_placed" },
          noop,
        ),
        /Confirm you checked its status in Sarvam/,
      );
      assert.equal(env.db.call(CALL_ID)["status"], "initiated");

      await resolveUnknownSarvamCall(
        env.db as never,
        { callId: CALL_ID, resolution: "not_placed", confirmedCheckedInSarvam: true },
        noop,
      );
      assert.equal(env.db.call(CALL_ID)["status"], "failed");

      const result = await send(env);
      assert.equal(result.outcome, "started");
      assert.equal(dials.count, 1);
    });
  });

  test("crash recovery when Sarvam did place it: 'placed' with the attempt id bills once and frees the number", async () => {
    const env = dialSetup();
    env.db.tables["call_logs"]!.push({
      id: CALL_ID,
      organization_id: ORG_ID,
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "initiated",
      provider_call_id: null,
      campaign_id: null,
      campaign_contact_id: null,
    });
    await resolveUnknownSarvamCall(
      env.db as never,
      {
        callId: CALL_ID,
        resolution: "placed",
        outcome: "completed",
        durationSeconds: 40,
        attemptId: "att_seen_in_sarvam",
        confirmedCheckedInSarvam: true,
      },
      {
        processEvent: (e, o) => applyEvent(env, e, o),
        finalize: async () => ({ state: "done" as const }),
      },
    );
    assert.equal(env.db.call(CALL_ID)["status"], "completed");
    assert.equal(env.db.call(CALL_ID)["provider_call_id"], "att_seen_in_sarvam");
    assert.deepEqual(env.charges, [{ callId: CALL_ID, seconds: 40 }]);
    // The late real webhook for that attempt can't bill again.
    await applyEvent(env, connected("att_seen_in_sarvam"));
    assert.equal(env.charges.length, 1);
  });

  test("campaign calls share the number reservation: a second campaign call to the same number is refused", async () => {
    const env = dialSetup();
    const campaignRow = (contact: string) => ({
      organization_id: ORG_ID,
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "initiated",
      campaign_contact_id: contact,
    });
    const first = await env.db.from("call_logs").insert(campaignRow("cc_a")).select("id").single();
    const second = await env.db.from("call_logs").insert(campaignRow("cc_b")).select("id").single();
    assert.equal(first.error, null);
    assert.equal((second.error as { code?: string } | null)?.code, "23505");
    // ...and a single call to that number is refused too, with nothing dialled.
    await withSarvam(async (dials) => {
      await assert.rejects(send(env), /hasn't finished/);
      assert.equal(dials.count, 0);
    });
  });

  test("an ambiguous start still holds the reservation (outcome_unknown) and is never retried automatically", async () => {
    const env = dialSetup();
    const { sendSarvamInstantOutboundCall } = await import("./sarvam-outbound-call.server.ts");
    await withSarvam(async () => {
      globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
      const first = await sendSarvamInstantOutboundCall(env.db as never, {
        phoneNumberId: "num_1",
        toE164: TO,
      });
      assert.equal(first.outcome, "unknown");
      assert.equal(env.db.tables["call_logs"]![0]!["status"], "outcome_unknown");
      await assert.rejects(send(env), /unconfirmed outcome/);
      assert.equal(env.db.tables["call_logs"]!.length, 1, "no second attempt was created");
    });
  });
});

describe("equivalent number formats share one reservation (single call vs campaign)", () => {
  const ORG_ID = "org_1";
  const CANONICAL = "+919876543210";

  function numberSetup() {
    const env = setup();
    env.db.tables["call_logs"] = [];
    env.db.tables["phone_numbers"] = [
      {
        id: "num_1",
        e164: "+911111111111",
        organization_id: ORG_ID,
        provider: "sarvam",
        connection_id: "conn_1",
        agent_config_id: "agent_1",
      },
    ];
    env.db.tables["telephony_connections"] = [
      { id: "conn_1", provider: "sarvam", provider_connection_id: "sarvam_conn_1" },
    ];
    env.db.tables["agent_configs"] = [
      { id: "agent_1", organization_id: ORG_ID, sarvam_app_id: "app_1", sarvam_app_version: 2 },
    ];
    return env;
  }

  async function withFakeSarvam<T>(fn: (dials: { count: number }) => Promise<T>): Promise<T> {
    const keys = [
      "SARVAM_API_KEY",
      "SARVAM_ORG_ID",
      "SARVAM_WORKSPACE_ID",
      "TELEPHONY_WEBHOOK_BASE_URL",
    ];
    const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      SARVAM_API_KEY: "sk_test",
      SARVAM_ORG_ID: "o",
      SARVAM_WORKSPACE_ID: "w",
      TELEPHONY_WEBHOOK_BASE_URL: "https://clickai.test",
    });
    const originalFetch = globalThis.fetch;
    const dials = { count: 0 };
    globalThis.fetch = (async () => {
      dials.count++;
      return new Response(JSON.stringify({ attempt_id: `att_${dials.count}` }), { status: 200 });
    }) as typeof fetch;
    try {
      return await fn(dials);
    } finally {
      globalThis.fetch = originalFetch;
      for (const k of keys) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    }
  }

  const send = async (env: ReturnType<typeof setup>, to: string) => {
    const { sendSarvamInstantOutboundCall } = await import("./sarvam-outbound-call.server.ts");
    return sendSarvamInstantOutboundCall(env.db as never, { phoneNumberId: "num_1", toE164: to });
  };

  for (const typed of ["0091 98765 43210", "+91 98765 43210", "+91-98765-43210"]) {
    test(`an open campaign call to ${CANONICAL} refuses a single call typed as "${typed}"`, async () => {
      const env = numberSetup();
      env.db.tables["call_logs"]!.push({
        organization_id: ORG_ID,
        provider: "sarvam",
        direction: "outbound",
        destination_number: CANONICAL,
        status: "initiated",
        campaign_contact_id: "cc_a",
      });
      await withFakeSarvam(async (dials) => {
        await assert.rejects(send(env, typed), /hasn't finished or has an unconfirmed outcome/);
        assert.equal(dials.count, 0);
      });
      assert.equal(env.db.tables["call_logs"]!.length, 1);
    });
  }

  test('an open single call placed as "0091 98765 43210" blocks a campaign insert for +919876543210', async () => {
    const env = numberSetup();
    await withFakeSarvam(async (dials) => {
      await send(env, "0091 98765 43210");
      assert.equal(dials.count, 1);
    });
    assert.equal(env.db.tables["call_logs"]![0]!["destination_number"], CANONICAL);
    const campaign = await env.db
      .from("call_logs")
      .insert({
        organization_id: ORG_ID,
        provider: "sarvam",
        direction: "outbound",
        destination_number: CANONICAL,
        status: "initiated",
        campaign_contact_id: "cc_a",
      })
      .select("id")
      .single();
    assert.equal((campaign.error as { code?: string } | null)?.code, "23505");
  });
});

describe("generic outbound path (telephony-outbound.functions.ts)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "telephony-outbound.functions.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  test("a reservation conflict on insert becomes the friendly refusal, before any dial or call-row update", () => {
    const conflict = src.indexOf(
      'if (insertError?.code === "23505") throw new Error(UNRESOLVED_CALL_MESSAGE);',
    );
    const rawRethrow = src.indexOf("if (insertError) throw insertError;");
    const dial = src.indexOf("adapter.initiateOutboundCall(");
    assert.ok(conflict > -1, "23505 is mapped to UNRESOLVED_CALL_MESSAGE");
    assert.ok(conflict < rawRethrow, "checked before the raw error is rethrown");
    assert.ok(rawRethrow < dial, "both happen before anything is dialled");
    assert.match(
      src,
      /import \{[^}]*\bUNRESOLVED_CALL_MESSAGE\b[^}]*\} from "@\/lib\/sarvam-outbound-call\.server";/,
    );
  });

  test("the message the user sees names the situation, not the database", async () => {
    const { UNRESOLVED_CALL_MESSAGE } = await import("./sarvam-outbound-call.server.ts");
    assert.match(UNRESOLVED_CALL_MESSAGE, /earlier call to this number/);
    assert.doesNotMatch(UNRESOLVED_CALL_MESSAGE, /23505|duplicate key|idx_|constraint/i);
  });

  test("a Sarvam number is refused before the wallet check, any call row or any provider request", async () => {
    const gate = src.indexOf("if (!gate.allowed || !gate.phoneNumber)");
    const refusal = src.indexOf(
      'if (gate.phoneNumber.provider === "sarvam")\n      throw new Error(SARVAM_USE_INSTANT_OUTBOUND_MESSAGE);',
    );
    const wallet = src.indexOf("await walletCanAffordOutbound(");
    const insert = src.indexOf('.from("call_logs")\n      .insert(');
    const dial = src.indexOf("adapter.initiateOutboundCall(");
    assert.ok(gate > -1 && refusal > gate, "right after the number is known");
    assert.ok(refusal < wallet && wallet < insert && insert < dial);
    assert.equal(src.split("SARVAM_USE_INSTANT_OUTBOUND_MESSAGE").length - 1, 2); // import + use

    const { SARVAM_USE_INSTANT_OUTBOUND_MESSAGE } =
      await import("./sarvam-outbound-call.server.ts");
    assert.match(SARVAM_USE_INSTANT_OUTBOUND_MESSAGE, /createSarvamInstantOutboundCall/);
  });

  test("other providers keep the generic path unchanged", () => {
    // Only Sarvam is refused; Exotel/Vobiz still insert and dial here.
    assert.equal(src.split('provider === "sarvam"').length - 1, 1);
    assert.match(src, /provider: gate\.phoneNumber\.provider,/);
  });
});

describe("every outbound entry point canonicalizes the destination", () => {
  for (const file of [
    "sarvam-outbound.functions.ts",
    "telephony-outbound.functions.ts",
    "sarvam-admin.functions.ts",
  ]) {
    test(`${file} validates with normalizeCustomerPhone and passes on the canonical value`, () => {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
      assert.match(src, /const toE164 = normalizeCustomerPhone\(input\.toE164, null\);/);
      assert.match(src, /return \{ \.\.\.input, toE164 \};/);
      assert.doesNotMatch(src, /\\d\{6,15\}/);
    });
  }
});

describe("campaign dispatch vs the number reservation", () => {
  const ORG_ID = "org_1";
  const TO = "+912222222222";

  function contactsSetup() {
    const env = setup();
    env.db.tables["call_logs"] = [];
    env.db.tables["campaign_contacts"] = [
      { id: "cc_a", status: "pending", attempts: 0, phone: TO },
      { id: "cc_b", status: "retry_scheduled", attempts: 1, phone: "+913333333333" },
    ];
    env.db.tables["campaigns"] = [{ id: "camp_1", status: "running" }];
    return env;
  }

  /**
   * The dispatcher's per-contact steps (campaign-dispatch.server.ts):
   * canonicalize the stored number (an invalid one becomes wrong_number and is
   * never claimed), claim the contact, insert its call row, and on an insert
   * error undo the claim with the real releaseCampaignClaim — deferring on
   * 23505, rethrowing otherwise.
   */
  async function dispatchContact(
    env: ReturnType<typeof setup>,
    ccId: string,
    /** The contact as this run read it (defaults to its current state). */
    staleRead?: Record<string, unknown>,
  ) {
    const { releaseCampaignClaim } = await import("./sarvam-outbound-call.server.ts");
    const { normalizeCustomerPhone } = await import("./phone-number.ts");
    const cc = { ...(staleRead ?? env.db.contact(ccId)) } as {
      id: string;
      status: string;
      attempts: number;
      phone: string;
    };
    const destination = normalizeCustomerPhone(cc.phone, null);
    if (!destination) {
      await env.db
        .from("campaign_contacts")
        .update({ status: "wrong_number", outcome: "invalid_number", next_attempt_at: null })
        .eq("id", cc.id)
        .in("status", ["pending", "retry_scheduled"]);
      return "invalid_number";
    }
    const attempts = cc.attempts + 1;
    const callId = randomUUID();
    const { data: claimed } = await env.db
      .from("campaign_contacts")
      .update({ status: "calling", attempts, current_call_id: callId })
      .eq("id", cc.id)
      .in("status", ["pending", "retry_scheduled"])
      .eq("attempts", cc.attempts)
      .select("id");
    if (!claimed || (claimed as unknown[]).length === 0) return "skipped";
    const { error } = await env.db
      .from("call_logs")
      .insert({
        id: callId,
        organization_id: ORG_ID,
        provider: "sarvam",
        direction: "outbound",
        status: "initiated",
        destination_number: destination,
        campaign_contact_id: cc.id,
      })
      .select("id")
      .single();
    if (error) {
      await releaseCampaignClaim(env.db as never, {
        campaignId: "camp_1",
        campaignContactId: cc.id,
        previousStatus: cc.status,
        previousAttempts: cc.attempts,
      });
      if ((error as { code?: string }).code === "23505") return "deferred";
      throw error;
    }
    return "dialled";
  }

  test("a reserved number defers the contact (claim undone exactly) and the next contact is still dialled", async () => {
    const env = contactsSetup();
    env.db.tables["call_logs"]!.push({
      id: "open-single-call",
      organization_id: ORG_ID,
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "initiated",
      campaign_contact_id: null,
    });
    assert.equal(await dispatchContact(env, "cc_a"), "deferred");
    assert.deepEqual(
      { status: env.db.contact("cc_a")["status"], attempts: env.db.contact("cc_a")["attempts"] },
      { status: "pending", attempts: 0 },
      "back exactly as it was — not stranded in `calling`, attempt not counted",
    );
    assert.equal(await dispatchContact(env, "cc_b"), "dialled");
    assert.equal(env.db.contact("cc_b")["status"], "calling");
  });

  test("a retry_scheduled contact is restored to retry_scheduled with its attempt count", async () => {
    const env = contactsSetup();
    env.db.contact("cc_b")["phone"] = TO;
    env.db.tables["call_logs"]!.push({
      organization_id: ORG_ID,
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "outcome_unknown",
      campaign_contact_id: null,
    });
    assert.equal(await dispatchContact(env, "cc_b"), "deferred");
    assert.deepEqual(
      { status: env.db.contact("cc_b")["status"], attempts: env.db.contact("cc_b")["attempts"] },
      { status: "retry_scheduled", attempts: 1 },
    );
  });

  test("once the open call is final, the deferred contact is dialled on a later run", async () => {
    const env = contactsSetup();
    env.db.tables["call_logs"]!.push({
      id: "open-single-call",
      organization_id: ORG_ID,
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "initiated",
      campaign_contact_id: null,
    });
    assert.equal(await dispatchContact(env, "cc_a"), "deferred");
    env.db.tables["call_logs"]![0]!["status"] = "completed";
    assert.equal(await dispatchContact(env, "cc_a"), "dialled");
    assert.equal(env.db.contact("cc_a")["attempts"], 1);
  });

  test("releaseCampaignClaim never overwrites a contact that has moved on (webhook outcome or a newer claim)", async () => {
    const { releaseCampaignClaim } = await import("./sarvam-outbound-call.server.ts");
    const env = contactsSetup();
    env.db.contact("cc_a")["status"] = "completed"; // a webhook already recorded the outcome
    assert.equal(
      await releaseCampaignClaim(env.db as never, {
        campaignId: "camp_1",
        campaignContactId: "cc_a",
        previousStatus: "pending",
        previousAttempts: 0,
      }),
      "unchanged",
    );
    assert.equal(env.db.contact("cc_a")["status"], "completed");

    env.db.contact("cc_b")["status"] = "calling";
    env.db.contact("cc_b")["attempts"] = 3; // claimed again by a later run (attempts moved past ours)
    assert.equal(
      await releaseCampaignClaim(env.db as never, {
        campaignId: "camp_1",
        campaignContactId: "cc_b",
        previousStatus: "retry_scheduled",
        previousAttempts: 1,
      }),
      "unchanged",
    );
    assert.deepEqual(
      { status: env.db.contact("cc_b")["status"], attempts: env.db.contact("cc_b")["attempts"] },
      { status: "calling", attempts: 3 },
    );
  });

  test("an undo after the campaign was cancelled leaves the contact cancelled, not pending", async () => {
    const env = contactsSetup();
    env.db.tables["call_logs"]!.push({
      organization_id: ORG_ID,
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "initiated",
      campaign_contact_id: null,
    });
    // cancelCampaign lands after our claim: it marks the campaign cancelled, and its
    // pending/retry_scheduled sweep misses cc_a because cc_a is `calling`.
    const realFrom = env.db.from;
    env.db.from = (table: string) => {
      if (table === "call_logs") env.db.tables["campaigns"]![0]!["status"] = "cancelled";
      return realFrom(table);
    };
    assert.equal(await dispatchContact(env, "cc_a"), "deferred");
    assert.deepEqual(
      { status: env.db.contact("cc_a")["status"], attempts: env.db.contact("cc_a")["attempts"] },
      { status: "cancelled", attempts: 0 },
    );
  });

  test("a cancellation landing between the restore and the re-check still ends cancelled", async () => {
    const { releaseCampaignClaim } = await import("./sarvam-outbound-call.server.ts");
    const env = contactsSetup();
    env.db.contact("cc_b")["status"] = "calling";
    env.db.contact("cc_b")["attempts"] = 2;
    let cancelled = false;
    env.db.afterUpdate["campaign_contacts"] = async () => {
      if (cancelled) return;
      cancelled = true;
      // cancelCampaign completes right after our restore; its contact sweep ran
      // a moment earlier, while cc_b was still `calling`.
      env.db.tables["campaigns"]![0]!["status"] = "cancelled";
    };
    assert.equal(
      await releaseCampaignClaim(env.db as never, {
        campaignId: "camp_1",
        campaignContactId: "cc_b",
        previousStatus: "retry_scheduled",
        previousAttempts: 1,
      }),
      "cancelled",
    );
    assert.deepEqual(
      { status: env.db.contact("cc_b")["status"], attempts: env.db.contact("cc_b")["attempts"] },
      { status: "cancelled", attempts: 1 },
    );
  });

  test("a running campaign's claim is restored as before", async () => {
    const { releaseCampaignClaim } = await import("./sarvam-outbound-call.server.ts");
    const env = contactsSetup();
    env.db.contact("cc_a")["status"] = "calling";
    env.db.contact("cc_a")["attempts"] = 1;
    assert.equal(
      await releaseCampaignClaim(env.db as never, {
        campaignId: "camp_1",
        campaignContactId: "cc_a",
        previousStatus: "pending",
        previousAttempts: 0,
      }),
      "restored",
    );
    assert.deepEqual(
      { status: env.db.contact("cc_a")["status"], attempts: env.db.contact("cc_a")["attempts"] },
      { status: "pending", attempts: 0 },
    );
  });

  test("a stored number that isn't valid E.164 is marked wrong_number: no claim, no call row", async () => {
    const env = contactsSetup();
    env.db.contact("cc_a")["phone"] = "+910987654321"; // passes the contacts CHECK, not a real Indian number
    assert.equal(await dispatchContact(env, "cc_a"), "invalid_number");
    assert.deepEqual(
      {
        status: env.db.contact("cc_a")["status"],
        attempts: env.db.contact("cc_a")["attempts"],
        outcome: env.db.contact("cc_a")["outcome"],
      },
      { status: "wrong_number", attempts: 0, outcome: "invalid_number" },
    );
    assert.equal(env.db.tables["call_logs"]!.length, 0);
  });

  test("the claim records its call (current_call_id); a deferral clears it", async () => {
    const env = contactsSetup();
    assert.equal(await dispatchContact(env, "cc_b"), "dialled");
    const call = env.db.tables["call_logs"]!.find((r) => r["campaign_contact_id"] === "cc_b")!;
    assert.equal(env.db.contact("cc_b")["current_call_id"], call["id"]);

    env.db.tables["call_logs"]!.push({
      organization_id: ORG_ID,
      provider: "sarvam",
      direction: "outbound",
      destination_number: TO,
      status: "initiated",
      campaign_contact_id: null,
    });
    assert.equal(await dispatchContact(env, "cc_a"), "deferred");
    assert.equal(env.db.contact("cc_a")["current_call_id"], null);
  });

  test("a run working from a stale read can't claim a contact another run already dialled", async () => {
    const env = contactsSetup();
    const staleRead = { ...env.db.contact("cc_b") }; // retry_scheduled, attempts 1
    assert.equal(await dispatchContact(env, "cc_b"), "dialled"); // attempts 2
    // That call finished and the contact is due again (finalization's retry decision).
    env.db.contact("cc_b")["status"] = "retry_scheduled";
    // Without the attempts condition this claim would succeed and record a third
    // dial as attempt 2 (an under-count): it must be refused instead.
    assert.equal(await dispatchContact(env, "cc_b", staleRead), "skipped");
    assert.equal(env.db.contact("cc_b")["attempts"], 2);
    assert.equal(
      env.db.tables["call_logs"]!.filter((r) => r["campaign_contact_id"] === "cc_b").length,
      1,
    );
  });

  test("a non-conflict insert error still undoes the claim, then propagates", async () => {
    const env = contactsSetup();
    const realFrom = env.db.from;
    env.db.from = (table: string) => {
      const b = realFrom(table);
      if (table === "call_logs") {
        b.then = async (resolve) =>
          resolve({ data: null, error: { code: "57014", message: "statement timeout" } });
      }
      return b;
    };
    await assert.rejects(
      dispatchContact(env, "cc_a"),
      (e: unknown) => (e as { code?: string }).code === "57014",
    );
    assert.deepEqual(
      { status: env.db.contact("cc_a")["status"], attempts: env.db.contact("cc_a")["attempts"] },
      { status: "pending", attempts: 0 },
    );
  });

  test("the real dispatcher follows exactly these steps", () => {
    const dispatch = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "campaign-dispatch.server.ts"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    assert.match(dispatch, /\.select\("id, contact_id, status, attempts, variables"\)/);
    const onError = dispatch.slice(dispatch.indexOf("if (insertError) {"));
    const release = onError.indexOf("await releaseCampaignClaim(supabaseAdmin, {");
    const conflict = onError.indexOf('if (insertError.code === "23505") {');
    const rethrow = onError.indexOf("throw insertError;");
    assert.ok(
      release > -1 && release < conflict && conflict < rethrow,
      "undo the claim first, then defer or rethrow",
    );
    assert.match(onError.slice(conflict, rethrow), /skipped\+\+;\s*continue;/);
    assert.match(onError, /previousStatus: cc\.status,\s*previousAttempts: cc\.attempts,/);
    const normalize = dispatch.indexOf(
      "const destination = normalizeCustomerPhone(contact.phone, null);",
    );
    const claim = dispatch.indexOf('.update({ status: "calling"');
    assert.ok(normalize > -1 && normalize < claim, "the number is canonicalized before the claim");
    assert.match(dispatch, /destination_number: destination,/);
    assert.match(dispatch, /toE164: destination,/);
    assert.match(onError, /campaignId: campaign\.id,/);
    assert.doesNotMatch(dispatch, /if \(insertError\) throw insertError;/);
  });

  test("a single call and a campaign insert racing for the same number: exactly one call row", async () => {
    const env = contactsSetup();
    const ORG = "org_1";
    env.db.tables["phone_numbers"] = [
      {
        id: "num_1",
        e164: "+911111111111",
        organization_id: ORG,
        provider: "sarvam",
        connection_id: "conn_1",
        agent_config_id: "agent_1",
      },
    ];
    env.db.tables["telephony_connections"] = [
      { id: "conn_1", provider: "sarvam", provider_connection_id: "c" },
    ];
    env.db.tables["agent_configs"] = [
      { id: "agent_1", organization_id: ORG, sarvam_app_id: "app", sarvam_app_version: 1 },
    ];
    const keys = [
      "SARVAM_API_KEY",
      "SARVAM_ORG_ID",
      "SARVAM_WORKSPACE_ID",
      "TELEPHONY_WEBHOOK_BASE_URL",
    ];
    const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      SARVAM_API_KEY: "k",
      SARVAM_ORG_ID: "o",
      SARVAM_WORKSPACE_ID: "w",
      TELEPHONY_WEBHOOK_BASE_URL: "https://clickai.test",
    });
    const originalFetch = globalThis.fetch;
    let dials = 0;
    globalThis.fetch = (async () => {
      dials++;
      return new Response(JSON.stringify({ attempt_id: "att_single" }), { status: 200 });
    }) as typeof fetch;
    try {
      const { sendSarvamInstantOutboundCall } = await import("./sarvam-outbound-call.server.ts");
      const [single, campaign] = await Promise.allSettled([
        sendSarvamInstantOutboundCall(env.db as never, { phoneNumberId: "num_1", toE164: TO }),
        dispatchContact(env, "cc_a"),
      ]);
      const rowsForNumber = env.db.tables["call_logs"]!.filter(
        (r) => r["destination_number"] === TO,
      );
      assert.equal(rowsForNumber.length, 1, "only one call row for the number");
      if (single.status === "fulfilled") {
        assert.deepEqual(campaign, { status: "fulfilled", value: "deferred" });
        assert.equal(env.db.contact("cc_a")["status"], "pending");
        assert.equal(dials, 1);
      } else {
        assert.deepEqual(campaign, { status: "fulfilled", value: "dialled" });
        assert.match(String(single.reason), /hasn't finished or has an unconfirmed outcome/);
        assert.equal(dials, 0, "the single call was never sent to Sarvam");
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const k of keys) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    }
  });
});
