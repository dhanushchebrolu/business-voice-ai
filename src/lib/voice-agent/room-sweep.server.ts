/**
 * Independent maximum-duration backstop for INBOUND SIP calls
 * (Phase 2.9, hardened in Phase 2.11).
 *
 * The voice agent ends a call itself. When it cannot (process died, network
 * lost, LiveKit refused its delete-room request), the caller can stay
 * connected to a room nobody serves. This sweep runs in klyro (cron, every
 * 5 minutes), independently of the agent, and deletes such rooms. Deleting
 * a room disconnects every participant; open-source LiveKit's SIP service
 * then hangs up the phone call (livekit/sip inbound.go: lkRoom.Closed() ->
 * closeWithTerm). LiveKit Cloud behaviour is NOT verified by that source
 * reading; staging acceptance tests in STAGING.md §6c must confirm it.
 *
 * Rows considered (inbound, provider livekit_sip, answered in the last 24 h):
 *   A. active, no agent end report, older than the limit recorded for THIS
 *      call at session start (provider_metadata.max_call_seconds; 7200 s for
 *      older agents and older rows) + 5 min.
 *   B. active, the agent reported the end more than 5 min ago, LiveKit never
 *      confirmed that the caller left.
 *   C. closed without LiveKit's confirmation (billed from the agent's
 *      report, or closed by reconcile's 3-hour rule).
 *   plus rows an earlier run is still handling (retry / waiting / stale).
 * And rooms with no answered row at all (orphans, F4): see sweepOrphanRooms.
 *
 * Per row (F7: verify first, close last):
 *   1. claim a lease (conditional update; a webhook or another sweep that
 *      changed the row first wins and nothing happens);
 *   2. list the room's participants. Nothing is closed or deleted unless the
 *      room is the one recorded for this call (prefix "call-"), every SIP
 *      participant in it is THIS call (sip.callID = provider_call_id), and
 *      NO agent participant is connected (F1: a live agent means a live
 *      call, whatever any end report says). Otherwise the row is left as it
 *      is ("waiting" for the agent, or "mismatch" / "invalid_room" with an
 *      alert);
 *   3. for an active row, record the decision how to close it
 *      (room_sweep_close) with a conditional update that requires the call
 *      to be still active: a LiveKit webhook that completed the call first
 *      wins and the room is NOT deleted ("superseded");
 *   4. delete the room;
 *   5. only now close the row as decided. The participant_left webhook the
 *      deletion causes applies the same recorded decision
 *      (completeSipCallFromLiveKit), so stranded time is never billed:
 *        A -> failed "max_duration_exceeded", not billed;
 *        B -> completed at the agent's reported end, billed once with that
 *             duration (billing "retry", or by the webhook).
 *      If the deletion fails, the row stays active (the room may still be
 *      up) and is retried.
 *
 * Reliability (F3, F5, F8): every database result is checked (a database
 * error is not a "lost race"); one row's failure never aborts the run; each
 * run stops claiming work before its time (18 s; pg_net's request timeout is
 * 25 s) or subrequest budget (45; Workers Free allows 50) runs out;
 * failures back off exponentially (5 min .. 1 h) until the row leaves the
 * 24 h window; a lease abandoned by a cancelled run counts as a failed
 * attempt; the "room_sweep_failed" alert fires once per row.
 */
import {
  ACTIVE_STATUSES,
  DbError,
  MAX_CALL_SECONDS_CEILING,
  casUpdateCall,
  checked,
  maxCallSecondsFromEnv,
  mergeCall,
  meta,
  validMaxCallSeconds,
  type CallLog,
  type CallUpdate,
  type Client,
  type Meta,
} from "./call-meta.ts";
import {
  LiveKitApiError,
  allowedLiveKitHosts,
  deleteLiveKitRoom,
  listLiveKitRooms,
  livekitApiBase,
  listRoomParticipants,
  type RoomParticipant,
} from "./livekit-api.ts";

export { DEFAULT_MAX_CALL_SECONDS, maxCallSecondsFromEnv } from "./call-meta.ts";

const SIP_PROVIDER = "livekit_sip";

/** Time after the limit (or after the agent's end report) before the sweep acts. */
export const ROOM_SWEEP_GRACE_MS = 5 * 60_000;
/** Calls answered longer ago than this are no longer handled. */
export const ROOM_SWEEP_LOOKBACK_MS = 24 * 3_600_000;
/** A sweep holding a row for longer than this is presumed dead. */
export const ROOM_SWEEP_LEASE_MS = 2 * 60_000;
/** Failures after which "voice_agent:room_sweep_failed" fires (once). Retries continue. */
export const ROOM_SWEEP_ALERT_AFTER_FAILURES = 6;
export const ROOM_SWEEP_BACKOFF_BASE_MS = 5 * 60_000;
export const ROOM_SWEEP_BACKOFF_MAX_MS = 60 * 60_000;
/** Recheck interval while the agent is still in the room. */
export const ROOM_SWEEP_WAIT_MS = 5 * 60_000;
/** Agent still in the room this long after the call's limit + grace -> alert. */
export const ROOM_SWEEP_AGENT_STUCK_MS = 30 * 60_000;
export const ROOM_SWEEP_MAX_ROWS_PER_RUN = 5;
/** Run budget: below pg_net's 25 s request timeout (scripts/staging/schedule-cron.sql). */
export const ROOM_SWEEP_RUN_BUDGET_MS = 18_000;
/** Subrequest budget: below the Workers Free limit of 50 per invocation. */
export const ROOM_SWEEP_SUBREQUEST_BUDGET = 45;
export const ROOM_SWEEP_LIVEKIT_TIMEOUT_MS = 4000;
/** Worst-case subrequests one row may still need (claim, list, intent, delete, close + retries). */
const ROW_SUBREQUEST_RESERVE = 10;
/** Room prefix of the inbound dispatch rule (deploy/livekit/provision-sip.ts). */
export const INBOUND_ROOM_PREFIX = "call-";
/** Orphan rooms (no active row) are deleted only once this old and agent-less. */
export const ORPHAN_ROOM_MIN_AGE_MS = 10 * 60_000;
export const ORPHAN_ROOMS_PER_RUN = 2;
const ORPHAN_SUBREQUEST_RESERVE = 5;

export interface RoomSweepDeps {
  db: Client;
  now: () => Date;
  /** klyro's default limit; only used for rows without a recorded limit (they get the ceiling). */
  maxCallSeconds: number;
  /** null when LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not configured. */
  livekit: {
    url: string;
    apiKey: string;
    apiSecret: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** LIVEKIT_ALLOWED_HOSTS (livekit-api.ts livekitApiBase). */
    allowedHosts?: readonly string[];
  } | null;
  /** Overrides for tests. */
  budget?: { runMs?: number; subrequests?: number };
}

/** Values of provider_metadata.room_sweep. */
export type RoomSweepState =
  | "pending" // a sweep holds the row (lease)
  | "deleting" // the close decision is recorded; the room is being deleted
  | "retry" // the last attempt failed; retried after room_sweep_next_at
  | "waiting" // the agent is still in the room; rechecked later
  | "done" // the room was deleted (and the row closed as decided)
  | "gone" // the room no longer existed or was empty
  | "superseded" // LiveKit confirmed the end first: nothing deleted
  | "mismatch" // the room holds something else: nothing deleted (alert)
  | "invalid_room" // no or unexpected room name recorded: nothing deleted (alert)
  | "expired"; // left the 24 h window unresolved (alert)

const IN_FLIGHT: RoomSweepState[] = ["pending", "deleting", "retry", "waiting"];

export interface RoomSweepSummary {
  examined: number;
  closedNoAgentReport: number;
  closedFromAgentReport: number;
  roomsDeleted: number;
  roomsGone: number;
  retryScheduled: number;
  waitingForAgent: number;
  agentStuck: number;
  alertsRaised: number;
  mismatched: number;
  invalidRoom: number;
  superseded: number;
  expired: number;
  lostRace: number;
  deferred: number;
  dbErrors: number;
  rowErrors: number;
  orphanRoomsDeleted: number;
  orphanRoomsSkipped: number;
  subrequests: number;
  elapsedMs: number;
  budgetExhausted: boolean;
  unconfigured: boolean;
}

type Kind = "A" | "B" | "C";
type Candidate = { row: CallLog; kind: Kind };
type Intent =
  { status: "failed"; reason: string } | { status: "completed"; seconds: number; endedAt: string };

/** Counts every awaited database query (one HTTP subrequest each). */
function countingDb(db: Client, onAwait: () => void): Client {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(o, k) {
        const v = Reflect.get(o, k, o) as unknown;
        if (k === "then" && typeof v === "function")
          return (res: unknown, rej: unknown) => {
            onAwait();
            return (v as (a: unknown, b: unknown) => unknown).call(o, res, rej);
          };
        if (typeof v === "function")
          return (...a: unknown[]) => {
            const out = (v as (...x: unknown[]) => unknown).apply(o, a);
            return out && typeof out === "object" ? wrap(out as object) : out;
          };
        return v;
      },
    });
  return wrap(db as unknown as object) as unknown as Client;
}

const errorText = (e: unknown) =>
  (e instanceof LiveKitApiError ? `${e.status}: ${e.message}` : String(e)).slice(0, 200);

const rowLimitSeconds = (row: CallLog) =>
  validMaxCallSeconds(meta(row)["max_call_seconds"]) ?? MAX_CALL_SECONDS_CEILING;

const backoffMs = (failures: number) =>
  Math.min(ROOM_SWEEP_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), ROOM_SWEEP_BACKOFF_MAX_MS);

function emptySummary(): RoomSweepSummary {
  return {
    examined: 0,
    closedNoAgentReport: 0,
    closedFromAgentReport: 0,
    roomsDeleted: 0,
    roomsGone: 0,
    retryScheduled: 0,
    waitingForAgent: 0,
    agentStuck: 0,
    alertsRaised: 0,
    mismatched: 0,
    invalidRoom: 0,
    superseded: 0,
    expired: 0,
    lostRace: 0,
    deferred: 0,
    dbErrors: 0,
    rowErrors: 0,
    orphanRoomsDeleted: 0,
    orphanRoomsSkipped: 0,
    subrequests: 0,
    elapsedMs: 0,
    budgetExhausted: false,
    unconfigured: false,
  };
}

/** Selects the rows to look at. Throws DbError (the run cannot do its job). */
async function selectCandidates(db: Client, nowMs: number): Promise<Candidate[]> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const base = () =>
    db
      .from("call_logs")
      .select("*")
      .eq("provider", SIP_PROVIDER)
      .eq("direction", "inbound")
      .gte("answered_at", iso(nowMs - ROOM_SWEEP_LOOKBACK_MS));
  const run = async (op: string, q: unknown) =>
    (checked(
      op,
      await (q as PromiseLike<{ data: CallLog[] | null; error: { message?: string } | null }>),
    ) ?? []) as CallLog[];
  const limit = 50;
  const [active, c1, c2, inflight] = await Promise.all([
    // A and B (the per-row limit is applied below: it is stored per call).
    run(
      "room_sweep.select_active",
      base()
        .in("status", ACTIVE_STATUSES)
        .is("ended_at", null)
        .is("provider_metadata->>room_sweep", null)
        .lt("answered_at", iso(nowMs - 60_000 - ROOM_SWEEP_GRACE_MS))
        .order("answered_at", { ascending: true })
        .limit(limit),
    ),
    run(
      "room_sweep.select_agent_report",
      base()
        .eq("status", "completed")
        .eq("provider_metadata->>billing_source", "agent_report")
        .is("provider_metadata->>room_sweep", null)
        .order("answered_at", { ascending: true })
        .limit(limit),
    ),
    run(
      "room_sweep.select_end_missing",
      base()
        .eq("status", "failed")
        .eq("failure_reason", "livekit_end_event_missing")
        .is("provider_metadata->>room_sweep", null)
        .order("answered_at", { ascending: true })
        .limit(limit),
    ),
    run(
      "room_sweep.select_in_flight",
      base()
        .in("provider_metadata->>room_sweep", IN_FLIGHT)
        .order("answered_at", { ascending: true })
        .limit(limit),
    ),
  ]);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (row: CallLog, kind: Kind) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ row, kind });
  };
  // In-flight first (they already hold a decision), oldest first.
  for (const row of inflight) {
    const m = meta(row);
    const state = m["room_sweep"] as RoomSweepState;
    const due =
      state === "pending" || state === "deleting"
        ? nowMs - Date.parse(String(m["room_sweep_lease"])) > ROOM_SWEEP_LEASE_MS ||
          !Number.isFinite(Date.parse(String(m["room_sweep_lease"])))
        : !(typeof m["room_sweep_next_at"] === "string") ||
          Date.parse(m["room_sweep_next_at"] as string) <= nowMs;
    const kind = (["A", "B", "C"] as const).find((k) => k === m["room_sweep_kind"]);
    if (due && kind) add(row, kind);
  }
  for (const row of active) {
    const m = meta(row);
    const answered = Date.parse(String(row.answered_at));
    if (typeof m["agent_ended_at"] === "string") {
      if (nowMs - Date.parse(m["agent_ended_at"]) > ROOM_SWEEP_GRACE_MS) add(row, "B");
    } else if (nowMs - answered > rowLimitSeconds(row) * 1000 + ROOM_SWEEP_GRACE_MS) {
      add(row, "A");
    }
  }
  for (const row of [...c1, ...c2]) add(row, "C");
  return out;
}

class Budget {
  readonly started: number;
  subrequests = 0;
  private readonly runMs: number;
  private readonly max: number;
  private readonly clock: () => number;
  constructor(deps: RoomSweepDeps, clock: () => number) {
    this.clock = clock;
    this.started = clock();
    this.runMs = deps.budget?.runMs ?? ROOM_SWEEP_RUN_BUDGET_MS;
    this.max = deps.budget?.subrequests ?? ROOM_SWEEP_SUBREQUEST_BUDGET;
  }
  /** Enough time and subrequests left for one more unit of work? */
  allows(reserveRequests: number, reserveMs: number): boolean {
    return (
      this.subrequests + reserveRequests <= this.max &&
      this.clock() - this.started + reserveMs <= this.runMs
    );
  }
  elapsed(): number {
    return this.clock() - this.started;
  }
}

interface RowCtx {
  deps: RoomSweepDeps;
  db: Client;
  lk: NonNullable<RoomSweepDeps["livekit"]> & { onRequest: () => void; timeoutMs: number };
  summary: RoomSweepSummary;
  nowIso: () => string;
  nowMs: () => number;
}

/** Records a state on a row we hold (lease), merged into its current metadata. */
async function finishRow(
  ctx: RowCtx,
  rowId: string,
  lease: string,
  patch: Meta,
  extra: CallUpdate = {},
  opts: { requireActive?: boolean } = {},
): Promise<CallLog | null> {
  return mergeCall(
    ctx.db,
    rowId,
    (fresh) => {
      const m = meta(fresh);
      if (m["room_sweep_lease"] !== lease) return null;
      if (opts.requireActive && (!ACTIVE_STATUSES.includes(fresh.status) || fresh.ended_at))
        return null;
      return {
        ...(opts.requireActive ? { requireActive: true } : {}),
        update: {
          ...extra,
          provider_metadata: { ...m, ...patch, room_sweep_at: ctx.nowIso() } as never,
        },
      };
    },
    "room_sweep.finish",
  );
}

function intentFor(c: Candidate): Intent | null {
  if (c.kind === "C") return null;
  if (c.kind === "A") return { status: "failed", reason: "max_duration_exceeded" };
  const m = meta(c.row);
  const answered = Date.parse(String(c.row.answered_at));
  const ended = Date.parse(String(m["agent_ended_at"]));
  if (!Number.isFinite(answered) || !Number.isFinite(ended)) return null;
  return {
    status: "completed",
    seconds: Math.max(0, Math.min(Math.round((ended - answered) / 1000), MAX_CALL_SECONDS_CEILING)),
    endedAt: m["agent_ended_at"] as string,
  };
}

/** The update that closes an active row as decided. */
function closeUpdate(intent: Intent, nowIso: string): { update: CallUpdate; meta: Meta } {
  if (intent.status === "failed")
    return {
      update: { status: "failed", failure_reason: intent.reason, ended_at: nowIso },
      meta: {},
    };
  return {
    update: { status: "completed", ended_at: intent.endedAt, duration_seconds: intent.seconds },
    meta: { billing: "retry", billing_source: "agent_report" },
  };
}

async function sweepRow(ctx: RowCtx, c: Candidate): Promise<void> {
  const { summary } = ctx;
  const nowMs = ctx.nowMs();
  const m0 = meta(c.row);
  const prevState = m0["room_sweep"] as RoomSweepState | undefined;
  // A lease left by a run that was cancelled counts as a failed attempt (F5).
  const abandoned = prevState === "pending" || prevState === "deleting";
  const failures =
    (typeof m0["room_sweep_failures"] === "number" ? m0["room_sweep_failures"] : 0) +
    (abandoned ? 1 : 0);
  const lease = ctx.nowIso();
  const answered = Date.parse(String(c.row.answered_at));
  const expired = nowMs - answered > ROOM_SWEEP_LOOKBACK_MS - 60 * 60_000;
  const alertNow = failures >= ROOM_SWEEP_ALERT_AFTER_FAILURES && m0["room_sweep_alerted"] !== true;
  const isActive = ACTIVE_STATUSES.includes(c.row.status) && !c.row.ended_at;
  const log = (extra: Meta = {}) => ({
    callId: c.row.id,
    organizationId: c.row.organization_id,
    room: m0["livekit_room"] ?? null,
    kind: c.kind,
    failures,
    ...extra,
  });

  // 1. Claim (lease). For a row that should still be active, the claim
  //    requires it to be active: a webhook that closed it first wins.
  const claimed = await casUpdateCall(
    ctx.db,
    c.row,
    {
      provider_metadata: {
        ...m0,
        room_sweep: expired ? "expired" : prevState === "deleting" ? "deleting" : "pending",
        room_sweep_lease: lease,
        room_sweep_kind: c.kind,
        room_sweep_failures: failures,
        ...(alertNow ? { room_sweep_alerted: true } : {}),
      } as never,
    },
    { ...(isActive ? { requireActive: true } : {}), op: "room_sweep.claim" },
  );
  if (!claimed) {
    summary.lostRace++;
    return;
  }
  if (alertNow) {
    summary.alertsRaised++;
    console.error("voice_agent:room_sweep_failed", log({ error: m0["room_sweep_error"] ?? null }));
  }
  if (expired) {
    summary.expired++;
    console.error("voice_agent:room_sweep_expired", log());
    return;
  }

  const fail = async (error: string) => {
    const f = failures + 1;
    summary.retryScheduled++;
    console.warn("voice_agent:room_sweep_retry", log({ error, failures: f }));
    await finishRow(ctx, c.row.id, lease, {
      room_sweep: "retry",
      room_sweep_failures: f,
      room_sweep_error: error,
      room_sweep_next_at: new Date(ctx.nowMs() + backoffMs(f)).toISOString(),
    });
    if (f >= ROOM_SWEEP_ALERT_AFTER_FAILURES && meta(claimed)["room_sweep_alerted"] !== true) {
      // The alert fires once: record it on the row first.
      const marked = await finishRow(ctx, c.row.id, lease, { room_sweep_alerted: true });
      if (marked) {
        summary.alertsRaised++;
        console.error("voice_agent:room_sweep_failed", log({ error, failures: f }));
      }
    }
  };

  // 2. Verify the room before changing anything else.
  const room = m0["livekit_room"];
  if (
    typeof room !== "string" ||
    !room.startsWith(INBOUND_ROOM_PREFIX) ||
    room.length > 256 ||
    /[\s/]/.test(room)
  ) {
    summary.invalidRoom++;
    console.error("voice_agent:room_sweep_invalid_room", log());
    await finishRow(ctx, c.row.id, lease, { room_sweep: "invalid_room" });
    return;
  }
  const params = { ...ctx.lk, room };
  let participants: RoomParticipant[] | "not_found";
  try {
    participants = await listRoomParticipants(params);
  } catch (e) {
    await fail(errorText(e));
    return;
  }
  const intent = intentFor(c);
  const closeAs = async (state: "done" | "gone") => {
    // Close the row as decided (only while still active), with the outcome.
    if (intent && ACTIVE_STATUSES.includes(claimed.status)) {
      const cu = closeUpdate(intent, ctx.nowIso());
      const closed = await finishRow(
        ctx,
        c.row.id,
        lease,
        { ...cu.meta, room_sweep: state, room_sweep_close: intent },
        cu.update,
        { requireActive: true },
      );
      if (closed) {
        if (c.kind === "A") summary.closedNoAgentReport++;
        if (c.kind === "B") summary.closedFromAgentReport++;
        return;
      }
      // Already closed meanwhile (the webhook applied the same decision).
    }
    await finishRow(ctx, c.row.id, lease, { room_sweep: state });
  };

  if (participants === "not_found" || participants.length === 0) {
    summary.roomsGone++;
    await closeAs("gone");
    return;
  }
  if (participants.some((p) => p.isAgent)) {
    // F1: a connected agent means a live call. Never delete; recheck later.
    summary.waitingForAgent++;
    const stuck =
      c.kind === "A" &&
      nowMs - answered >
        rowLimitSeconds(c.row) * 1000 + ROOM_SWEEP_GRACE_MS + ROOM_SWEEP_AGENT_STUCK_MS &&
      m0["room_sweep_stuck_alerted"] !== true;
    if (stuck) {
      summary.agentStuck++;
      console.error("voice_agent:room_sweep_agent_stuck", log());
    }
    await finishRow(ctx, c.row.id, lease, {
      room_sweep: "waiting",
      room_sweep_next_at: new Date(ctx.nowMs() + ROOM_SWEEP_WAIT_MS).toISOString(),
      ...(stuck ? { room_sweep_stuck_alerted: true } : {}),
    });
    return;
  }
  const sip = participants.filter((p) => p.sipCallId !== null);
  if (
    sip.length === 0 ||
    sip.some((p) => p.sipCallId !== c.row.provider_call_id) ||
    participants.length !== sip.length
  ) {
    summary.mismatched++;
    console.error("voice_agent:room_sweep_mismatch", log({ participants: participants.length }));
    await finishRow(ctx, c.row.id, lease, { room_sweep: "mismatch" });
    return;
  }

  // 3. Record the close decision; requires the call to be still active.
  if (intent && ACTIVE_STATUSES.includes(claimed.status)) {
    const recorded = await finishRow(
      ctx,
      c.row.id,
      lease,
      { room_sweep: "deleting", room_sweep_close: intent },
      {},
      { requireActive: true },
    );
    if (!recorded) {
      // LiveKit confirmed the end first (or another writer won): no deletion.
      summary.superseded++;
      await finishRow(ctx, c.row.id, lease, { room_sweep: "superseded" });
      return;
    }
  }

  // 4. Delete the room.
  let deleted: "deleted" | "not_found";
  try {
    deleted = await deleteLiveKitRoom(params);
  } catch (e) {
    // The room may still be up: the row stays active (with its decision).
    await fail(errorText(e));
    return;
  }

  // 5. Close the row as decided.
  if (deleted === "deleted") {
    summary.roomsDeleted++;
    console.warn("voice_agent:room_swept", log());
  } else summary.roomsGone++;
  await closeAs(deleted === "deleted" ? "done" : "gone");
}

/**
 * F4: rooms of inbound calls that have no active answered row (unknown
 * number, refused at session start, klyro unreachable) and whose agent has
 * left. Only "call-" rooms older than 10 minutes, with at least one SIP
 * participant, no agent, nothing but SIP participants, and no ACTIVE row
 * for any of their SIP call ids (rows that exist must name this room).
 */
async function sweepOrphanRooms(ctx: RowCtx, budget: Budget): Promise<void> {
  const { summary } = ctx;
  if (!budget.allows(1 + ORPHAN_SUBREQUEST_RESERVE, 2 * ctx.lk.timeoutMs + 2000)) return;
  let rooms;
  try {
    rooms = await listLiveKitRooms(ctx.lk);
  } catch (e) {
    console.warn("voice_agent:orphan_room_list_failed", { error: errorText(e) });
    summary.rowErrors++;
    return;
  }
  const nowMs = ctx.nowMs();
  const candidates = rooms
    .filter(
      (r) =>
        r.name.startsWith(INBOUND_ROOM_PREFIX) &&
        r.name.length <= 256 &&
        !/[\s/]/.test(r.name) &&
        r.createdAtMs !== null &&
        nowMs - r.createdAtMs > ORPHAN_ROOM_MIN_AGE_MS &&
        r.numParticipants > 0,
    )
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  // Rotate the starting point every 5 minutes, so rooms that are skipped on
  // every run (agent still present, active call) cannot starve the others.
  const offset = candidates.length ? Math.floor(nowMs / (5 * 60_000)) % candidates.length : 0;
  const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)];
  let done = 0;
  for (const r of ordered) {
    if (done >= ORPHAN_ROOMS_PER_RUN) break;
    if (!budget.allows(ORPHAN_SUBREQUEST_RESERVE, 2 * ctx.lk.timeoutMs + 1000)) {
      summary.budgetExhausted = true;
      break;
    }
    done++;
    try {
      const params = { ...ctx.lk, room: r.name };
      const ps = await listRoomParticipants(params);
      if (ps === "not_found" || ps.length === 0 || ps.some((p) => p.isAgent)) {
        summary.orphanRoomsSkipped++;
        continue;
      }
      const ids = ps.map((p) => p.sipCallId);
      if (ids.some((id) => id === null)) {
        summary.orphanRoomsSkipped++;
        continue;
      }
      const rows = (checked(
        "room_sweep.orphan_rows",
        await ctx.db
          .from("call_logs")
          .select("id, status, ended_at, organization_id, provider_metadata")
          .eq("provider", SIP_PROVIDER)
          .in("provider_call_id", ids as string[]),
      ) ?? []) as Array<
        Pick<CallLog, "id" | "status" | "ended_at" | "organization_id" | "provider_metadata">
      >;
      if (rows.some((x) => ACTIVE_STATUSES.includes(x.status) && !x.ended_at)) {
        summary.orphanRoomsSkipped++; // the row-based sweep owns it
        continue;
      }
      // A room an ACTIVE call recorded as its own is never an orphan, whoever
      // is in it now (the row-based sweep reports it as a mismatch).
      const owners = (checked(
        "room_sweep.orphan_owner",
        await ctx.db
          .from("call_logs")
          .select("id")
          .eq("provider", SIP_PROVIDER)
          .eq("provider_metadata->>livekit_room", r.name)
          .in("status", ACTIVE_STATUSES)
          .is("ended_at", null)
          .limit(1),
      ) ?? []) as Array<{ id: string }>;
      if (owners.length) {
        summary.orphanRoomsSkipped++;
        continue;
      }
      if (
        rows.some(
          (x) => typeof meta(x)["livekit_room"] === "string" && meta(x)["livekit_room"] !== r.name,
        )
      ) {
        summary.orphanRoomsSkipped++;
        console.error("voice_agent:orphan_room_mismatch", {
          room: r.name,
          calls: rows.map((x) => x.id),
        });
        continue;
      }
      const res = await deleteLiveKitRoom(params);
      if (res === "deleted") {
        summary.orphanRoomsDeleted++;
        console.warn("voice_agent:orphan_room_swept", {
          room: r.name,
          ageMs: nowMs - (r.createdAtMs ?? nowMs),
          calls: rows.map((x) => ({
            id: x.id,
            organizationId: x.organization_id,
            status: x.status,
          })),
        });
      }
    } catch (e) {
      if (e instanceof DbError) summary.dbErrors++;
      else summary.rowErrors++;
      console.error(
        e instanceof DbError ? "voice_agent:room_sweep_db_error" : "voice_agent:orphan_room_error",
        { room: r.name, error: errorText(e) },
      );
    }
  }
}

export async function sweepOverdueSipRooms(deps: RoomSweepDeps): Promise<RoomSweepSummary> {
  const summary = emptySummary();
  if (!deps.livekit) {
    // Without LiveKit credentials nothing can be verified or deleted: touch nothing.
    summary.unconfigured = true;
    console.error("voice_agent:room_sweep_unconfigured", { reason: "credentials_missing" });
    return summary;
  }
  try {
    // F13: refuse an insecure or unexpected LiveKit URL before any token exists.
    livekitApiBase(deps.livekit.url, deps.livekit.allowedHosts);
  } catch (e) {
    summary.unconfigured = true;
    console.error("voice_agent:room_sweep_unconfigured", {
      reason: "livekit_url_rejected",
      error: (e as Error).message,
    });
    return summary;
  }
  const clock = () => deps.now().getTime();
  const budget = new Budget(deps, clock);
  const db = countingDb(deps.db, () => budget.subrequests++);
  const timeoutMs = deps.livekit.timeoutMs ?? ROOM_SWEEP_LIVEKIT_TIMEOUT_MS;
  const ctx: RowCtx = {
    deps,
    db,
    lk: { ...deps.livekit, timeoutMs, onRequest: () => budget.subrequests++ },
    summary,
    nowIso: () => new Date(clock()).toISOString(),
    nowMs: clock,
  };
  try {
    // A failing selection means the job cannot be done: DbError propagates (HTTP 500).
    const candidates = await selectCandidates(db, clock());
    for (const c of candidates) {
      if (summary.examined >= ROOM_SWEEP_MAX_ROWS_PER_RUN) {
        summary.deferred++;
        continue;
      }
      if (!budget.allows(ROW_SUBREQUEST_RESERVE, 2 * timeoutMs + 2000)) {
        summary.deferred++;
        summary.budgetExhausted = true;
        continue;
      }
      summary.examined++;
      try {
        await sweepRow(ctx, c);
      } catch (e) {
        // One row never aborts the run (F5); the lease expires and the row is retried.
        if (e instanceof DbError) summary.dbErrors++;
        else summary.rowErrors++;
        console.error(
          e instanceof DbError
            ? "voice_agent:room_sweep_db_error"
            : "voice_agent:room_sweep_row_error",
          { callId: c.row.id, organizationId: c.row.organization_id, error: errorText(e) },
        );
      }
    }
    await sweepOrphanRooms(ctx, budget);
  } finally {
    summary.subrequests = budget.subrequests;
    summary.elapsedMs = budget.elapsed();
  }
  return summary;
}

/** True when the run could not reliably do its job (the route answers 500). */
export function sweepFailed(s: RoomSweepSummary): boolean {
  return s.dbErrors > 0 || s.rowErrors > 0;
}

/** Production wiring (server-only). */
export async function defaultRoomSweepDeps(): Promise<RoomSweepDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const env = (n: string) => process.env[n];
  const url = env("LIVEKIT_URL");
  const apiKey = env("LIVEKIT_API_KEY");
  const apiSecret = env("LIVEKIT_API_SECRET");
  return {
    db: supabaseAdmin as unknown as Client,
    now: () => new Date(),
    maxCallSeconds: maxCallSecondsFromEnv(env("VOICE_AGENT_MAX_CALL_SECONDS")),
    livekit:
      url && apiKey && apiSecret
        ? {
            url,
            apiKey,
            apiSecret,
            allowedHosts: allowedLiveKitHosts(env("LIVEKIT_ALLOWED_HOSTS")),
          }
        : null,
  };
}
