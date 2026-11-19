/**
 * Local browser harness only (never built into the app): an in-memory stand-in
 * for src/lib/sarvam-outbound.functions.ts, swapped in by
 * dev-harness/calls/vite.config.ts. It follows the real server functions'
 * contracts (status shape, request-id dedupe, refusal messages, outcomes), so
 * the REAL PlaceCallDialog and CallsHistory components can be exercised in a
 * browser with no database, no provider and no secrets.
 *
 * Scenario from ?scenario=: ready (default), blocked, night, low_balance,
 * not_admin, provider_error, unconfirmed, slow.
 */
import type { CustomerCallRow } from "@/lib/workspace";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "ready";
const RATE = 400;
const MAX_MINUTES = 15;

interface HarnessState {
  calls: CustomerCallRow[];
  /** Every createSarvamInstantOutboundCall request the "server" received. */
  requests: { key: string; to: string }[];
  /** Calls actually "dialled" (a request id repeat never dials). */
  dials: number;
}
const state: HarnessState = { calls: seedCalls(), requests: [], dials: 0 };
(window as unknown as { __harness: HarnessState }).__harness = state;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seedCalls(): CustomerCallRow[] {
  const base = {
    organization_id: "org_demo",
    business_id: "biz_demo",
    phone_number_id: "num_demo",
    provider: "sarvam",
    provider_call_id: null,
    caller_name: null,
    language: "en-IN",
    agent_version: 6,
    recording_url: null,
    lead_score: null,
    currency: "INR",
    answered_at: null,
    failure_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return [
    {
      ...base,
      id: "seed_in",
      direction: "inbound",
      caller_number: "+919876500011",
      destination_number: "+917965860061",
      status: "completed",
      outcome: "booked",
      duration_seconds: 95,
      transcript: [
        { role: "user", text: "I'd like a cleaning on Friday." },
        { role: "assistant", text: "Friday at 11:00 is free. Shall I book it?" },
      ],
      summary: "Booked a cleaning for Friday 11:00.",
      customer_charge: 800,
      started_at: new Date(Date.now() - 3600_000).toISOString(),
      ended_at: new Date(Date.now() - 3500_000).toISOString(),
    },
    {
      ...base,
      id: "seed_unknown",
      direction: "outbound",
      caller_number: "+917965860061",
      destination_number: "+919876500022",
      status: "outcome_unknown",
      outcome: null,
      duration_seconds: null,
      transcript: null,
      summary: null,
      customer_charge: null,
      started_at: new Date(Date.now() - 7200_000).toISOString(),
      ended_at: null,
    },
  ] as unknown as CustomerCallRow[];
}

export async function getOutboundCallingStatus(_: { data: { orgId: string } }) {
  await wait(200);
  const open = state.calls.filter((c) =>
    ["initiated", "ringing", "answered", "in_progress"].includes(c.status),
  ).length;
  const blockers: string[] = [];
  if (scenario === "night")
    blockers.push("Calls can only be placed between 9:00 AM and 9:00 PM India time.");
  if (scenario === "low_balance")
    blockers.push(
      `Your wallet balance is too low: each call needs enough for its longest possible length (${MAX_MINUTES} minutes). Add funds to call.`,
    );
  return {
    numbers: [
      {
        id: "num_demo",
        e164: "+917965860061",
        displayNumber: "+91 79658 60061",
        blockers:
          scenario === "blocked"
            ? ["Outbound calling is not switched on for this number yet."]
            : [],
      },
    ],
    ratePerMinute: RATE,
    maxCallMinutes: MAX_MINUTES,
    walletBalance: scenario === "low_balance" ? 1200 : 54_800,
    currency: "INR",
    limits: { inFlight: 3, perHour: 30, perDay: 100, perDestinationDay: 2 },
    inFlight: open,
    lastHour: state.calls.length,
    blockers,
    canDial: scenario !== "not_admin",
  };
}

export async function createSarvamInstantOutboundCall({
  data,
}: {
  data: { phoneNumberId: string; toE164: string; objective?: string; idempotencyKey: string };
}) {
  state.requests.push({ key: data.idempotencyKey, to: data.toE164 });
  await wait(scenario === "slow" ? 3000 : 900);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(data.idempotencyKey))
    throw new Error("This request is missing a valid request id. Reload the page and try again.");
  const repeat = state.calls.find(
    (c) => (c as unknown as { key?: string }).key === data.idempotencyKey,
  );
  if (repeat) return { callId: repeat.id, outcome: "started" as const, duplicate: true };
  if (scenario === "provider_error")
    throw new Error("Sarvam rejected the call: the destination number is not reachable.");
  if (state.calls.some((c) => c.destination_number === data.toE164 && c.status === "initiated"))
    throw new Error(
      "An earlier call to this number hasn't finished or has an unconfirmed outcome. Wait for it, or resolve it in call history, before calling again.",
    );
  state.dials++;
  const id = `call_${state.dials}`;
  const row = {
    ...state.calls[0]!,
    id,
    key: data.idempotencyKey,
    direction: "outbound",
    caller_number: "+917965860061",
    destination_number: data.toE164,
    status: scenario === "unconfirmed" ? "outcome_unknown" : "initiated",
    outcome: null,
    duration_seconds: null,
    transcript: null,
    summary: null,
    customer_charge: null,
    started_at: new Date().toISOString(),
    ended_at: null,
  } as unknown as CustomerCallRow;
  state.calls.unshift(row);
  if (scenario !== "unconfirmed")
    // Sarvam's result webhook arrives a few seconds later.
    setTimeout(() => {
      Object.assign(row, {
        status: "completed",
        outcome: "callback_requested",
        duration_seconds: 47,
        customer_charge: RATE,
        summary: data.objective ? `Called about: ${data.objective}` : "Outbound call completed.",
        ended_at: new Date().toISOString(),
      });
    }, 6000);
  return {
    callId: id,
    outcome: scenario === "unconfirmed" ? ("unknown" as const) : ("started" as const),
    duplicate: false,
  };
}

/** The harness's stand-in for the customer's own call-history query. */
export async function listCalls(): Promise<CustomerCallRow[]> {
  await wait(150);
  return state.calls.map((c) => ({ ...c }));
}
