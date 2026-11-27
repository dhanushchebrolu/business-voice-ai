import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { ProvisionOrganizationResult } from "./provisioning-orchestrator.server.ts";
import { runProvisioningPipeline, type PipelineResult } from "./provisioning-pipeline.server.ts";
import {
  JOB_STEP_KEYS,
  MAX_AUTOMATIC_ATTEMPTS,
  backoffMs,
  beginStep,
  CUSTOMER_PROBLEM,
  CUSTOMER_RETRYING,
  classifyOutcome,
  endStep,
  sanitizeDiagnostic,
  type FailureCode,
  type JobStepKey,
  type StepStates,
} from "./voice-provisioning-job.ts";
import { AGENT_AUDIT, CONFIRMATION_ACTIONS } from "./tool-auth-checkpoint.server.ts";

/**
 * Persistent, resumable provisioning (provisioning_runs, migration
 * 20261114100000). Each organization has at most one active run
 * (pending/running/waiting), enforced by a partial unique index, so
 * repeated submissions, a submission racing an admin retry, or two Worker
 * isolates can never provision the same organization twice in parallel.
 *
 * A run is claimed with a conditional update before any work starts; a run
 * already "running" is left alone unless it has not moved for
 * STALE_RUNNING_MS (a crashed attempt), in which case it is reclaimed.
 *
 * It is also the automated Voice AI provisioning JOB (migration
 * 20261203090000): per-step state (step_states, current_job_step,
 * last_checkpoint), failure code + retryability, bounded automatic retries
 * with backoff (pending + next_attempt_at = "retrying"), customer-safe
 * message, sanitized diagnostics and an event trail (provisioning_run_events).
 * The pipeline re-reads real provider/DB state every attempt, so resuming
 * "from the last checkpoint" never repeats or duplicates finished work.
 */

export type ProvisioningTrigger =
  "setup_fee" | "phone_service_fee" | "admin_retry" | "customer_activate";
export type ProvisioningRunStatus = "pending" | "running" | "waiting" | "succeeded" | "failed";

export const ACTIVE_RUN_STATUSES = ["pending", "running", "waiting"] as const;
export const STALE_RUNNING_MS = 10 * 60 * 1000;

type Admin = SupabaseClient<Database>;
export interface OrchestrateHooks {
  /** The pipeline reports each step as it starts; the job persists it. */
  onStep: (key: JobStepKey) => Promise<void>;
  /** Nobody asked for this attempt (the sweep): a live number gets no provider call. */
  unattended: boolean;
}
type Orchestrate = (
  admin: Admin,
  organizationId: string,
  hooks: OrchestrateHooks,
) => Promise<ProvisionOrganizationResult>;

export interface RunProvisioningInput {
  organizationId: string;
  trigger: ProvisioningTrigger;
  sourcePaymentId?: string | null;
  createdBy?: string | null;
  /** What the job was started for (default "<trigger>:<organization>"); kept for traceability. */
  idempotencyKey?: string;
  /** Admin retry: run now even if an automatic retry is scheduled for later. */
  force?: boolean;
  /** The sweep: continue this job only, if it is still open. Never creates one. */
  onlyRunId?: string;
}

export interface RunProvisioningResult {
  runId: string;
  /** false when another attempt holds the run (or a retry is scheduled); nothing was done. */
  claimed: boolean;
  status: ProvisioningRunStatus | "running";
  result: ProvisionOrganizationResult | null;
}

/** Maps the orchestrator's state onto the run lifecycle. */
export function runStatusFor(result: ProvisionOrganizationResult): ProvisioningRunStatus {
  if (result.state === "active") return "succeeded";
  if (
    result.state === "failed" ||
    result.state === "verification_failed" ||
    result.state === "manual_action_required"
  )
    return "failed";
  return "waiting";
}

async function findOrCreateActiveRun(admin: Admin, input: RunProvisioningInput): Promise<string> {
  const find = async () => {
    const { data, error } = await admin
      .from("provisioning_runs")
      .select("id")
      .eq("organization_id", input.organizationId)
      .in("status", [...ACTIVE_RUN_STATUSES])
      .maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  };

  const existing = await find();
  if (existing) return existing;

  const { data, error } = await admin
    .from("provisioning_runs")
    .insert({
      organization_id: input.organizationId,
      trigger: input.trigger,
      source_payment_id: input.sourcePaymentId ?? null,
      created_by: input.createdBy ?? null,
      idempotency_key: input.idempotencyKey ?? `${input.trigger}:${input.organizationId}`,
      status: "pending",
      attempts: 0,
    })
    .select("id")
    .single();
  if (!error) return data.id;
  // Lost a race with a concurrent caller: use the run it created.
  if ((error as { code?: string }).code === "23505") {
    const winner = await find();
    if (winner) return winner;
  }
  throw error;
}

/** Event trail; a failed write is logged, never allowed to break provisioning. */
async function addEvent(
  admin: Admin,
  run: { id: string; organizationId: string },
  event: string,
  step: string | null,
  detail?: Record<string, unknown>,
) {
  const { error } = await admin.from("provisioning_run_events").insert({
    run_id: run.id,
    organization_id: run.organizationId,
    step,
    event,
    detail: (detail ?? null) as Json | null,
  });
  if (error) console.error("provisioning_runs:event_write_failed", event, error.message);
}

const lastDoneStep = (states: StepStates): string | null =>
  [...JOB_STEP_KEYS].reverse().find((k) => states[k]?.status === "done") ?? null;

/** Below PostgREST's default row cap, so a short page really is the last one. */
const PAGE = 500;
const ORG_CHUNK = 200;

/** Every row of a query, page by page (the query must have a stable order). */
async function allRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return rows;
  }
}

type Tables = Database["public"]["Tables"];
/** A table a waiting job can be waiting on, and the columns whose change matters. */
export type WaitedOn = {
  [T in keyof Tables]: {
    table: T;
    columns: (keyof Tables[T]["Row"] & string)[];
    /** Narrows the rows: [column, the values kept]. */
    only?: [keyof Tables[T]["Row"] & string, string[]];
  };
}[keyof Tables];

/**
 * Everything a person changes to resolve a waiting state. Only facts the pipeline never
 * writes itself (not a number's link, deployment, verification or activation) and nothing a
 * live call writes (a credential's last use), so a run is never news to its own job.
 */
export const WAITED_ON: WaitedOn[] = [
  {
    table: "agent_configs",
    columns: [
      "business_id",
      "sarvam_app_id",
      "sarvam_app_version",
      "sarvam_outbound_app_id",
      "sarvam_outbound_app_version",
      "sarvam_outbound_ready_app_id",
      "sarvam_outbound_ready_version",
    ],
  },
  {
    table: "agent_voice_language_settings",
    columns: [
      "status",
      "default_language",
      "allowed_languages",
      "auto_language_switch",
      "sarvam_voice_internal_id",
      "applied_sarvam_app_id",
      "applied_sarvam_app_version",
    ],
  },
  {
    table: "phone_numbers",
    columns: ["e164", "provider", "status", "sarvam_number_confirmed_at"],
  },
  { table: "telephony_connections", columns: ["provider", "provider_connection_id"] },
  { table: "sarvam_agent_integrations", columns: ["role", "status", "expires_at"] },
  {
    table: "provisioning_run_events",
    columns: ["event"],
    only: ["event", ["agent_tools_created", "tool_auth_confirmed", "agent_id_released"]],
  },
  {
    table: "audit_logs",
    columns: ["action"],
    only: ["action", [...CONFIRMATION_ACTIONS, AGENT_AUDIT.released]],
  },
];

/** The business data the onboarding check reads; compared only while a job waits for it. */
export const BUSINESS_SETUP: WaitedOn[] = (
  [
    "agent_configs",
    "businesses",
    "business_hours",
    "services",
    "faqs",
    "business_rules",
    "knowledge_documents",
  ] as const
).map((table) => ({ table, columns: ["updated_at"] }));

/** What one row says that a job could be waiting for; null: nothing. */
function factsOf({ table, columns }: WaitedOn, row: Record<string, unknown>): unknown[] | null {
  if (table !== "phone_numbers") return columns.map((c) => row[c]);
  // A released number is gone, and of its statuses only "suspended" is a person's to resolve
  // (the pipeline itself makes a number "active").
  if (row["status"] === "released") return null;
  return columns.map((c) => (c === "status" ? row[c] === "suspended" : row[c]));
}

/** One digest per customer of the given tables' facts. */
async function digest(admin: Admin, watched: WaitedOn[], organizationIds: string[]) {
  const facts = new Map(organizationIds.map((org) => [org, [] as string[]]));
  // WaitedOn type-checks each table and column; this generic reader is untyped.
  const reader = admin as unknown as SupabaseClient;
  // In chunks: the ids travel in the query's URL.
  for (let i = 0; i < organizationIds.length; i += ORG_CHUNK) {
    const ids = organizationIds.slice(i, i + ORG_CHUNK);
    const results = await Promise.all(
      watched.map((w) =>
        allRows<Record<string, unknown>>((from, to) => {
          const query = reader
            .from(w.table)
            .select(["id", "organization_id", ...w.columns].join(", "))
            .in("organization_id", ids);
          return (w.only ? query.in(w.only[0], w.only[1]) : query)
            .order("id")
            .range(from, to) as unknown as PromiseLike<{
            data: Record<string, unknown>[] | null;
            error: unknown;
          }>;
        }),
      ),
    );
    results.forEach((rows, n) => {
      const w = watched[n]!;
      for (const row of rows) {
        const values = factsOf(w, row);
        if (!values) continue;
        facts
          .get(String(row["organization_id"]))
          ?.push(JSON.stringify([w.table, row["id"], ...values]));
      }
    });
  }
  return new Map(
    [...facts].map(([org, lines]) => [
      org,
      createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32),
    ]),
  );
}

/**
 * What a waiting job is waiting ON, per customer, as "<prerequisites>#<business setup>"
 * digests of database content (no clocks). A run records the mark it saw BEFORE working, so a
 * change made while it was running still counts as news afterwards. The business setup half is
 * read only for `setupFor`.
 */
export async function changeMarks(
  admin: Admin,
  organizationIds: string[],
  setupFor: string[] = organizationIds,
) {
  const [prerequisites, setup] = await Promise.all([
    digest(admin, WAITED_ON, organizationIds),
    digest(admin, BUSINESS_SETUP, setupFor),
  ]);
  return new Map(
    organizationIds.map((org) => [org, `${prerequisites.get(org)}#${setup.get(org) ?? ""}`]),
  );
}

class Superseded extends Error {}

export async function runProvisioning(
  admin: Admin,
  input: RunProvisioningInput,
  orchestrate: Orchestrate = (a, org, hooks) =>
    runProvisioningPipeline(a, org, undefined, hooks.onStep, hooks),
  now: () => Date = () => new Date(),
): Promise<RunProvisioningResult> {
  const runId = input.onlyRunId ?? (await findOrCreateActiveRun(admin, input));

  const { data: current, error: readError } = await admin
    .from("provisioning_runs")
    .select(
      "id, status, attempts, updated_at, next_attempt_at, max_attempts, step_states, diagnostics",
    )
    .eq("id", runId)
    .single();
  if (readError) throw readError;

  // A job that finished after the sweep listed it stays finished.
  if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(current.status))
    return {
      runId,
      claimed: false,
      status: current.status as ProvisioningRunStatus,
      result: null,
    };

  const stale =
    current.status === "running" &&
    now().getTime() - new Date(current.updated_at).getTime() > STALE_RUNNING_MS;
  if (current.status === "running" && !stale) {
    return { runId, claimed: false, status: "running", result: null };
  }
  // A scheduled automatic retry waits for its time (only an admin retry jumps the queue).
  if (
    current.status === "pending" &&
    current.next_attempt_at &&
    new Date(current.next_attempt_at).getTime() > now().getTime() &&
    !input.force
  )
    return { runId, claimed: false, status: "pending", result: null };

  // Claim: only succeeds if nobody else changed the run since we read it.
  const { data: claimed, error: claimError } = await admin
    .from("provisioning_runs")
    .update({
      status: "running",
      attempts: current.attempts + 1,
      // The customer's submission takes over an older job, so the sweep may continue it.
      ...(input.trigger === "customer_activate" ? { trigger: input.trigger } : {}),
      started_at: now().toISOString(),
      next_attempt_at: null,
    })
    .eq("id", runId)
    .eq("status", current.status)
    // Every claim bumps attempts, so it doubles as an optimistic version.
    .eq("attempts", current.attempts)
    .select("id");
  if (claimError) throw claimError;
  if (!claimed?.length) return { runId, claimed: false, status: "running", result: null };

  // Every attempt the sweep makes, retries of a person's attempt included.
  const unattended = Boolean(input.onlyRunId);

  const attempt = current.attempts + 1;
  const maxAttempts = current.max_attempts ?? MAX_AUTOMATIC_ATTEMPTS;
  // Only consecutive failed attempts count toward the retry bound: clicks and
  // sweeps that merely found the job waiting must not use it up.
  const previousStreak = Number(
    (current.diagnostics as { retryStreak?: number } | null)?.retryStreak ?? 0,
  );
  const streak = previousStreak + 1;
  const run = { id: runId, organizationId: input.organizationId };
  let states = (current.step_states ?? {}) as StepStates;
  let currentKey: JobStepKey = "validating";
  let seenChange: string | undefined;
  await addEvent(admin, run, attempt === 1 ? "started" : "resumed", null, {
    attempt,
    trigger: input.trigger,
    checkpoint: lastDoneStep(states),
  });

  const nowIso = () => now().toISOString();
  const onStep = async (key: JobStepKey) => {
    currentKey = key;
    states = beginStep(states, key, nowIso());
    const { data: held, error } = await admin
      .from("provisioning_runs")
      .update({ current_job_step: key, step_states: states as unknown as Json })
      .eq("id", runId)
      .eq("attempts", attempt)
      .select("id");
    if (error) throw error;
    // A newer attempt reclaimed the job: stop here, before the next provider or database step.
    if (!held?.length) throw new Superseded();
    await addEvent(admin, run, "step_started", key, { attempt });
  };

  /** Writes how this attempt ended (shared by the result and the unexpected-error paths). */
  const finish = async (
    kind: "succeeded" | "waiting" | "retry" | "failed",
    f: {
      code: FailureCode | null;
      retryable: boolean | null;
      customerMessage: string | null;
      note: string;
      /** The pipeline state the attempt ended in (absent after an unexpected error). */
      state?: string;
      extra?: Record<string, unknown>;
    },
  ) => {
    if (kind === "succeeded") {
      currentKey = "complete";
      states = endStep(beginStep(states, "complete", nowIso()), "complete", "done", nowIso());
    } else if (states[currentKey]?.status === "running") {
      states = endStep(
        states,
        currentKey,
        kind === "waiting" ? "waiting" : "failed",
        nowIso(),
        f.code ?? undefined,
      );
    }
    const terminal = kind === "succeeded" || kind === "failed";
    const { data: agentRow } = await admin
      .from("agent_configs")
      .select("sarvam_app_id")
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const { error } = await admin
      .from("provisioning_runs")
      .update({
        status: kind === "retry" ? "pending" : kind,
        ...(f.state ? { current_step: f.state } : {}),
        current_job_step: currentKey,
        step_states: states as unknown as Json,
        last_checkpoint: lastDoneStep(states),
        failure_code: f.code,
        retryable: f.retryable,
        customer_message: f.customerMessage,
        diagnostics: {
          attempt,
          maxAttempts,
          retryStreak: kind === "retry" ? streak : 0,
          step: currentKey,
          note: sanitizeDiagnostic(f.note),
          seenChange,
          ...f.extra,
        } as unknown as Json,
        next_attempt_at:
          kind === "retry" ? new Date(now().getTime() + backoffMs(streak)).toISOString() : null,
        // Keep an agent id reported by the operator until the version is registered.
        ...(agentRow?.sarvam_app_id ? { sarvam_agent_id: agentRow.sarvam_app_id } : {}),
        finished_at: terminal ? nowIso() : null,
        ...(kind === "failed" || kind === "retry"
          ? { last_error: sanitizeDiagnostic(f.note), last_error_at: nowIso() }
          : {}),
      })
      .eq("id", runId)
      // A superseded attempt (reclaimed as stale) never overwrites the newer one.
      .eq("attempts", attempt);
    if (error) throw error;
    await addEvent(admin, run, kind === "retry" ? "retry_scheduled" : kind, currentKey, {
      attempt,
      code: f.code,
      retryable: f.retryable,
    });
  };

  let result: ProvisionOrganizationResult;
  try {
    seenChange = (await changeMarks(admin, [input.organizationId])).get(input.organizationId);
    result = await orchestrate(admin, input.organizationId, { onStep, unattended });
  } catch (err) {
    if (err instanceof Superseded)
      return { runId, claimed: false, status: "running", result: null };
    // An unexpected error ends this attempt (retried with backoff, bounded), never a stuck "running".
    const message = (err as Error).message ?? String(err);
    const retry = streak < maxAttempts;
    await finish(retry ? "retry" : "failed", {
      code: retry ? "INTERNAL_ERROR" : "RETRIES_EXHAUSTED",
      retryable: true,
      customerMessage: retry ? CUSTOMER_RETRYING : CUSTOMER_PROBLEM,
      note: message,
    }).catch((e) =>
      console.error("provisioning_runs:fail_write_failed", runId, (e as Error).message),
    );
    throw err;
  }

  const pipeline = result as Partial<PipelineResult>;
  const outcome = classifyOutcome({
    state: result.state,
    step: currentKey,
    failure: pipeline.failure,
    attempts: streak,
    maxAttempts,
  });
  const failingChecks = (pipeline.verification?.checks ?? []).filter((c) => !c.ok).map((c) => c.id);
  // The inbound number is live; the outbound agent is an internal follow-up.
  if (outcome.kind === "waiting" && result.state.startsWith("waiting_for_outbound")) {
    currentKey = "complete";
    states = endStep(beginStep(states, "complete", nowIso()), "complete", "done", nowIso());
  }
  await finish(
    outcome.kind,
    outcome.kind === "succeeded"
      ? {
          state: result.state,
          code: null,
          retryable: null,
          customerMessage: null,
          note: result.note,
        }
      : {
          state: result.state,
          code: outcome.code,
          retryable:
            outcome.kind === "failed" ? outcome.retryable : outcome.kind === "retry" ? true : null,
          customerMessage: outcome.customerMessage,
          note: result.note,
          extra: { state: result.state, failingChecks },
        },
  );
  const status: ProvisioningRunStatus = outcome.kind === "retry" ? "pending" : outcome.kind;

  // Fields the pipeline produced that do not depend on the job outcome.
  const { error: saveError } = await admin
    .from("provisioning_runs")
    .update({
      current_step: result.state,
      note: result.note,
      phone_number_id: result.phoneNumberId,
      sarvam_deployment_id: result.deploymentId ?? null,
      ...(pipeline.generatedConfig
        ? {
            generated_agent_config: pipeline.generatedConfig as unknown as Json,
            agent_config_fingerprint: pipeline.generatedConfig.fingerprint,
          }
        : {}),
      ...(pipeline.deploymentVerifiedAt
        ? { deployment_verified_at: pipeline.deploymentVerifiedAt }
        : {}),
      ...(pipeline.verification ? { verification: pipeline.verification as unknown as Json } : {}),
    })
    .eq("id", runId)
    .eq("attempts", attempt);
  if (saveError) throw saveError;

  return { runId, claimed: true, status, result };
}

export interface SweepResult {
  due: number;
  stuck: number;
  /** Waiting jobs whose prerequisites changed since their last attempt. */
  changed: number;
  processed: number;
  errors: number;
}

/**
 * The scheduled tick's provisioning sweep (job kind `sweep.provisioning_retry`,
 * every minute from the Worker cron). It never creates a job, and never reads or changes
 * the deployment of a number that has gone live. Resumes, through runProvisioning's own
 * claim and backoff checks:
 *   1. jobs whose automatic retry is due (pending + next_attempt_at <= now);
 *   2. jobs stuck "running" past the stale window (a crashed attempt);
 *   3. customer-started jobs in ANY waiting state whose prerequisites (WAITED_ON; business
 *      setup too while it waits for onboarding) CHANGED since the job last ran, so every
 *      person's step continues the job by itself. A job that has already re-run on the current
 *      state is left alone: re-running it every minute would change nothing and only grow the
 *      event trail.
 * Bounded per tick (maxRuns claimed runs, budgetMs); the rest take their turn in later ticks.
 */
export async function sweepProvisioningRetries(
  admin: Admin,
  options: {
    now?: Date;
    maxRuns?: number;
    budgetMs?: number;
    run?: (admin: Admin, input: RunProvisioningInput) => Promise<RunProvisioningResult>;
  } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const run = options.run ?? ((a, i) => runProvisioning(a, i));
  // Every candidate is read (no fixed window that a job could stay outside of).
  // shortcut: a full scan each minute; with thousands of waiting jobs, mark changed jobs instead.
  const [due, stuck, waiting] = await Promise.all([
    allRows((from, to) =>
      admin
        .from("provisioning_runs")
        .select("id, organization_id, trigger")
        .eq("status", "pending")
        .lte("next_attempt_at", now.toISOString())
        .order("next_attempt_at", { ascending: true })
        .order("id")
        .range(from, to),
    ),
    allRows((from, to) =>
      admin
        .from("provisioning_runs")
        .select("id, organization_id, trigger")
        .eq("status", "running")
        .lt("updated_at", new Date(now.getTime() - STALE_RUNNING_MS).toISOString())
        .order("id")
        .range(from, to),
    ),
    allRows((from, to) =>
      admin
        .from("provisioning_runs")
        .select("id, organization_id, trigger, current_step, diagnostics")
        .eq("status", "waiting")
        // Only a customer's own activation click authorizes going live automatically.
        .eq("trigger", "customer_activate")
        .order("id")
        .range(from, to),
    ),
  ]);

  let changed: typeof waiting = [];
  if (waiting.length) {
    const onboarding = (w: (typeof waiting)[number]) => w.current_step === "waiting_for_onboarding";
    const marks = await changeMarks(
      admin,
      waiting.map((w) => w.organization_id),
      waiting.filter(onboarding).map((w) => w.organization_id),
    );
    changed = waiting.filter((w) => {
      const mark = marks.get(w.organization_id)!;
      const seen = (w.diagnostics as { seenChange?: string } | null)?.seenChange ?? "";
      // Only a change since the job's last attempt is news; otherwise it would wait again.
      return onboarding(w) ? mark !== seen : mark.split("#")[0] !== seen.split("#")[0];
    });
  }

  // Fairness: each tick starts one place further along every list, and the lists take turns,
  // so jobs that keep failing (or a flood of one kind) cannot hold the others back.
  const tick = Math.floor(now.getTime() / 60_000);
  const lists = [due, stuck, changed].map((list) => {
    const at = list.length ? tick % list.length : 0;
    return [...list.slice(at), ...list.slice(0, at)];
  });
  const turns = Array.from({ length: Math.max(0, ...lists.map((l) => l.length)) }, (_, i) =>
    lists.flatMap((l) => l.slice(i, i + 1)),
  ).flat();
  const seen = new Set<string>();
  const queue = turns.filter((r) => !seen.has(r.organization_id) && seen.add(r.organization_id));
  const maxRuns = options.maxRuns ?? 3;
  const deadline = Date.now() + (options.budgetMs ?? 15_000);
  let processed = 0;
  let errors = 0;
  // Only claimed runs use up the tick's slots; a failing job does not block the next one.
  for (const r of queue) {
    if (processed >= maxRuns || errors >= maxRuns * 3 || Date.now() > deadline) break;
    try {
      const out = await run(admin, {
        organizationId: r.organization_id,
        trigger: r.trigger as ProvisioningTrigger,
        onlyRunId: r.id,
      });
      if (out.claimed) processed++;
    } catch (err) {
      errors++;
      console.error("provisioning_sweep:run_failed", (err as Error).message);
    }
  }
  return {
    due: due.length,
    stuck: stuck.length,
    changed: changed.length,
    processed,
    errors,
  };
}
