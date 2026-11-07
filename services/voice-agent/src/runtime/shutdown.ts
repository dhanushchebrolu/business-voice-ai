/**
 * Bounded shutdown for the agent worker (main process).
 *
 * @livekit/agents 1.9.5's own SIGTERM path (cli.js: drain -> close ->
 * exit 143) can wait forever in two start-up races, both reproduced in
 * containers (PRODUCTION_READINESS.md §H3):
 *  - a signal before AgentServer.run() has started: close() waits for a
 *    run that then starts the process pool and retries the WebSocket
 *    forever;
 *  - a signal while the process pool is still warming up: a job process
 *    that had not started yet is "closed" as a no-op, starts anyway, and
 *    the pool's close()/drain waits for its exit forever.
 * (A third cause, Node as PID 1 ignoring SIGTERM before any handler exists,
 * is fixed by tini in the image, not here.)
 *
 * This watchdog runs ALONGSIDE the framework's handler; it never replaces
 * the drain. The active-call count is read IN-PROCESS from the AgentServer
 * instance (`activeJobs`, a synchronous getter over the process pool),
 * captured when the server starts (captureAgentServer). No HTTP self-probe:
 * an event-loop stall only delays a poll, it can never turn into "0 calls".
 *
 *  - runtime never started (signal before run()) -> no call can exist ->
 *    exit after the grace period;
 *  - 0 active calls for two consecutive polls, at least `idleGraceMs` after
 *    the signal -> exit(143);
 *  - active calls, OR the count is unavailable after it was once known ->
 *    wait (an unknown count is treated as "calls may be active");
 *  - hard cap `hardCapMs` (drain timeout + margin, below the pod's
 *    terminationGracePeriodSeconds) -> exit(143) regardless, so the process
 *    always ends inside the platform's grace period.
 */

export interface ShutdownWatchdogOptions {
  /**
   * Active jobs (calls) in this worker. null ONLY when the runtime has not
   * been created yet. A throw, or null after a number was once returned, is
   * "unknown" and never counts as idle.
   */
  activeJobs: () => number | null | Promise<number | null>;
  exit: (code: number) => void;
  idleGraceMs: number;
  hardCapMs: number;
  pollMs?: number;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export function createShutdownWatchdog(o: ShutdownWatchdogOptions) {
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => undefined);
  let startedAt: number | null = null;
  let idlePolls = 0;
  let exited = false;
  let everKnown = false;
  let unknownLogged = false;
  const exit = (reason: string, active: number | null) => {
    if (exited) return;
    exited = true;
    log("shutdown.watchdog_exit", {
      reason,
      active_jobs: active,
      after_ms: startedAt === null ? 0 : now() - startedAt,
    });
    o.exit(143);
  };
  /** The count, or "unknown". */
  const read = async (): Promise<number | null | "unknown"> => {
    try {
      const n = await o.activeJobs();
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
        everKnown = true;
        return n;
      }
      if (n === null && !everKnown) return null; // runtime not created yet
      return "unknown";
    } catch {
      return "unknown";
    }
  };
  return {
    /** Call on SIGTERM/SIGINT. Idempotent. */
    trigger(signal: string): void {
      if (startedAt !== null) return;
      startedAt = now();
      log("shutdown.signal", { signal });
    },
    /** One poll. Returns true once it has exited. */
    async tick(): Promise<boolean> {
      if (startedAt === null || exited) return exited;
      const active = await read();
      const elapsed = now() - startedAt;
      if (elapsed >= o.hardCapMs) {
        exit("hard_cap", typeof active === "number" ? active : null);
        return true;
      }
      if (active === "unknown") {
        idlePolls = 0;
        if (!unknownLogged) {
          unknownLogged = true;
          log("shutdown.count_unavailable", { treated_as: "active" });
        }
        return false;
      }
      if ((active ?? 0) === 0) {
        idlePolls++;
        if (idlePolls >= 2 && elapsed >= o.idleGraceMs) {
          exit("idle", active);
          return true;
        }
      } else {
        idlePolls = 0;
      }
      return false;
    },
    get triggered() {
      return startedAt !== null;
    },
  };
}

/**
 * Production wiring: SIGTERM/SIGINT start the watchdog; a ref'd interval
 * polls it (keeping the process alive until it exits is the point).
 */
export function installShutdownWatchdog(
  o: ShutdownWatchdogOptions,
  proc: Pick<NodeJS.Process, "on"> = process,
): ReturnType<typeof createShutdownWatchdog> {
  const w = createShutdownWatchdog(o);
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const onSignal = (signal: string) => {
    w.trigger(signal);
    if (timer) return;
    timer = setInterval(() => {
      if (busy) return; // never overlap polls
      busy = true;
      void w
        .tick()
        .then((done) => {
          if (done && timer) clearInterval(timer);
        })
        .finally(() => {
          busy = false;
        });
    }, o.pollMs ?? 1000);
  };
  proc.on("SIGTERM", () => onSignal("SIGTERM"));
  proc.on("SIGINT", () => onSignal("SIGINT"));
  return w;
}

/** The part of @livekit/agents' AgentServer this module relies on. */
export interface ActiveJobsSource {
  readonly activeJobs: readonly unknown[];
}
interface AgentServerClass {
  prototype: { run: (...args: never[]) => Promise<unknown> };
}

const CAPTURED = Symbol.for("clickai.voiceAgent.capturedServer");

/**
 * Captures the AgentServer instance that cli.runApp() creates internally, at
 * the moment its run() starts (before the process pool or any job exists),
 * by wrapping AgentServer.prototype.run once. Returns a reader for the live
 * instance. cli.js imports AgentServer from the same module as the package
 * root, so the wrapper applies to that instance (tests/shutdown.spec.ts
 * checks this against the installed package).
 */
export function captureAgentServer(cls: AgentServerClass): () => ActiveJobsSource | null {
  const proto = cls.prototype as AgentServerClass["prototype"] & {
    [CAPTURED]?: { current: ActiveJobsSource | null };
  };
  if (!proto[CAPTURED]) {
    const box: { current: ActiveJobsSource | null } = { current: null };
    const original = proto.run;
    proto.run = function (this: ActiveJobsSource, ...args: never[]) {
      box.current = this;
      return original.apply(this, args);
    };
    proto[CAPTURED] = box;
  }
  const box = proto[CAPTURED]!;
  return () => box.current;
}

/** Active calls of the captured server; null only before run() started. */
export function activeJobsOf(get: () => ActiveJobsSource | null): number | null {
  const server = get();
  return server ? server.activeJobs.length : null;
}
