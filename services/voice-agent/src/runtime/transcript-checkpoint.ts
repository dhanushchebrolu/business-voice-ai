/**
 * Crash-safe transcript: the conversation so far is checkpointed to klyro
 * during the call (session-end with checkpoint: true), so an agent that
 * dies mid-call still leaves its transcript in call_logs. klyro merges per
 * segment (this job) and keeps the longest snapshot, so a retried, repeated
 * or late checkpoint never duplicates or loses turns.
 *
 * Write budget: at most one checkpoint per `minIntervalMs` (15 s), only when
 * there are new turns, never two in flight; the last turns are flushed by a
 * trailing timer. With klyro's session_end limit (10/min per call) that
 * leaves room for the two end-of-call reports.
 */
export interface CheckpointTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface TranscriptCheckpointerOptions {
  /** The transcript so far (call.ts transcriptFrom over the session history). */
  snapshot: () => CheckpointTurn[];
  /** Sends one checkpoint; a rejection is retried at the next opportunity. */
  send: (turns: CheckpointTurn[]) => Promise<void>;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** A failed checkpoint (message only). */
  onError?: (message: string) => void;
}

export const CHECKPOINT_MIN_INTERVAL_MS = 15_000;

export class TranscriptCheckpointer {
  private readonly o: Required<Omit<TranscriptCheckpointerOptions, "onError">> &
    Pick<TranscriptCheckpointerOptions, "onError">;
  private sent = 0;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private closed = false;
  /** Checkpoints actually sent (successful or not): for tests and telemetry. */
  attempts = 0;

  constructor(o: TranscriptCheckpointerOptions) {
    this.o = {
      minIntervalMs: CHECKPOINT_MIN_INTERVAL_MS,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...o,
    };
  }

  /** A conversation item was added: checkpoint now, or schedule one. */
  notify(): void {
    if (this.closed || this.o.snapshot().length <= this.sent) return;
    const wait = this.lastAttemptAt + this.o.minIntervalMs - this.o.now();
    if (this.inFlight || wait > 0) {
      this.schedule(Math.max(wait, 50));
      return;
    }
    this.flush();
  }

  private schedule(ms: number): void {
    if (this.timer !== null || this.closed) return;
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      this.notify();
    }, ms);
  }

  private flush(): void {
    const turns = this.o.snapshot();
    if (turns.length <= this.sent) return;
    this.lastAttemptAt = this.o.now();
    this.attempts++;
    this.inFlight = this.o
      .send(turns)
      .then(() => {
        this.sent = Math.max(this.sent, turns.length);
      })
      .catch((e: unknown) => this.o.onError?.((e as Error)?.message ?? "checkpoint failed"))
      .finally(() => {
        this.inFlight = null;
        if (!this.closed && this.o.snapshot().length > this.sent)
          this.schedule(this.o.minIntervalMs);
      });
  }

  /** The call is ending: no more checkpoints; waits for the one in flight (the final report follows). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
