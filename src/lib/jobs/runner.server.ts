import { PermanentJobError, type Job, type QueueStore } from "./queue.server.ts";

/**
 * Drains due jobs within a time budget. Each job runs under a per-job
 * timeout; success completes it, a thrown error fails it (retry with backoff,
 * or dead-letter for PermanentJobError / an unknown kind / the last attempt).
 * The queue's SQL functions fence every update on this runner's id, so a job
 * whose lease expired mid-run and was taken over is never overwritten here.
 */

export type JobHandler = (job: Job) => Promise<Record<string, unknown> | void>;

export interface RunOptions {
  worker: string;
  handlers: Record<string, JobHandler>;
  /** Stop claiming new batches after this long (the Worker's scheduled event is short-lived). */
  budgetMs: number;
  batchSize?: number;
  /** Per-job timeout; also the basis of the lease. */
  jobTimeoutMs?: number;
  now?: () => number;
}

export interface RunSummary {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
  lostLease: number;
  byKind: Record<string, { succeeded: number; failed: number }>;
}

class JobTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(`job timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runDueJobs(store: QueueStore, options: RunOptions): Promise<RunSummary> {
  const now = options.now ?? Date.now;
  const started = now();
  const batchSize = options.batchSize ?? 10;
  const jobTimeoutMs = options.jobTimeoutMs ?? 20_000;
  // The lease outlives the timeout, so a job is never re-claimed while it can still be running here.
  const leaseSeconds = Math.ceil(jobTimeoutMs / 1000) + 30;
  const summary: RunSummary = {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
    lostLease: 0,
    byKind: {},
  };
  const tally = (kind: string, ok: boolean) => {
    const k = (summary.byKind[kind] ??= { succeeded: 0, failed: 0 });
    if (ok) k.succeeded++;
    else k.failed++;
  };

  while (now() - started < options.budgetMs) {
    const jobs = await store.claim(options.worker, batchSize, leaseSeconds);
    if (jobs.length === 0) break;
    summary.claimed += jobs.length;
    for (const job of jobs) {
      const handler = options.handlers[job.kind];
      try {
        if (!handler) throw new PermanentJobError(`no handler for job kind "${job.kind}"`);
        const result = await withTimeout(handler(job), jobTimeoutMs);
        if (
          await store.complete(job.id, options.worker, (result as Record<string, unknown>) ?? null)
        ) {
          summary.succeeded++;
          tally(job.kind, true);
        } else summary.lostLease++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const outcome = await store.fail(
          job.id,
          options.worker,
          message,
          !(err instanceof PermanentJobError),
        );
        tally(job.kind, false);
        if (outcome === "dead") {
          summary.dead++;
          console.error("jobs:dead_letter", {
            id: job.id,
            kind: job.kind,
            attempts: job.attempts,
            error: message,
          });
        } else if (outcome === "queued") summary.retried++;
        else summary.lostLease++;
      }
    }
    if (jobs.length < batchSize) break;
  }
  return summary;
}
