import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseQueueStore, type QueueStore } from "./queue.server.ts";
import { runDueJobs, type JobHandler, type RunSummary } from "./runner.server.ts";
import { buildJobHandlers } from "./handlers.server.ts";

/**
 * One scheduled tick (the Worker's cron trigger, every minute):
 *   1. enqueue the periodic sweeps, idempotent per time bucket, so a
 *      duplicate or overlapping tick never creates a second sweep;
 *   2. drain due jobs within a time budget;
 *   3. log queue health as one structured line, plus a `jobs:alert` line
 *      when anything is dead-lettered or due work is waiting too long.
 *
 * Disable with JOBS_SCHEDULER_ENABLED=false (an operator kill switch; no deploy needed).
 */

export const ALERT_OLDEST_DUE_SECONDS = 10 * 60;

export interface TickOptions {
  supabaseAdmin: SupabaseClient<Database>;
  now?: Date;
  store?: QueueStore;
  handlers?: Record<string, JobHandler>;
  budgetMs?: number;
}

export interface TickResult {
  enqueued: string[];
  run: RunSummary;
  health: {
    dead: number;
    queued: number;
    running: number;
    oldestDueSeconds: number;
    alert: boolean;
  };
}

export function periodicJobs(now: Date): { kind: string; idempotencyKey: string }[] {
  const iso = now.toISOString();
  const minute = iso.slice(0, 16);
  const fiveMinute = `${iso.slice(0, 14)}${String(Math.floor(now.getUTCMinutes() / 5) * 5).padStart(2, "0")}`;
  return [
    { kind: "sweep.call_finalization", idempotencyKey: `sweep.call_finalization:${minute}` },
    { kind: "sweep.sarvam_reconcile", idempotencyKey: `sweep.sarvam_reconcile:${fiveMinute}` },
    { kind: "jobs.prune", idempotencyKey: `jobs.prune:${iso.slice(0, 10)}` },
  ];
}

export async function runScheduledTick(options: TickOptions): Promise<TickResult> {
  const now = options.now ?? new Date();
  const store = options.store ?? supabaseQueueStore(options.supabaseAdmin);
  const enqueued: string[] = [];
  for (const job of periodicJobs(now)) {
    const r = await store.enqueue({ ...job, maxAttempts: 3 });
    if (r.created) enqueued.push(job.kind);
  }

  const worker = `cron:${now.toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  const run = await runDueJobs(store, {
    worker,
    handlers: options.handlers ?? buildJobHandlers({ supabaseAdmin: options.supabaseAdmin, store }),
    budgetMs: options.budgetMs ?? 20_000,
  });

  const { data: stats } = await options.supabaseAdmin.rpc("job_queue_stats", {});
  const sum = (status: string) =>
    (stats ?? []).filter((s) => s.status === status).reduce((n, s) => n + Number(s.jobs), 0);
  const oldestDueSeconds = Math.max(
    0,
    ...(stats ?? []).map((s) => Number(s.oldest_due_seconds ?? 0)),
  );
  const health = {
    dead: sum("dead"),
    queued: sum("queued"),
    running: sum("running"),
    oldestDueSeconds,
    alert: sum("dead") > 0 || oldestDueSeconds > ALERT_OLDEST_DUE_SECONDS,
  };
  console.info("jobs:tick", { worker, enqueued, run, health });
  if (health.alert) console.error("jobs:alert", health);
  return { enqueued, run, health };
}

/** Entry point for the Worker's scheduled() event. */
export async function handleScheduledEvent(scheduledTime: number): Promise<void> {
  if (process.env["JOBS_SCHEDULER_ENABLED"] === "false") {
    console.info("jobs:tick_skipped", { reason: "JOBS_SCHEDULER_ENABLED=false" });
    return;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  try {
    await runScheduledTick({ supabaseAdmin, now: new Date(scheduledTime) });
  } catch (err) {
    console.error("jobs:tick_failed", { error: (err as Error).message });
  }
}
