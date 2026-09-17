/**
 * Starts a promise without blocking the caller's own response — the fix for
 * a production incident where a webhook route's `await` on downstream work
 * held up its HTTP response long enough that the provider gave up waiting
 * for it (see telephony.ts's `processTelephonyEvent`, the exact call site
 * this was extracted from, for the full incident writeup).
 *
 * On Cloudflare Workers, returning a Response signals "this request is
 * done" — any promise still in flight that isn't registered with the
 * platform's `ExecutionContext.waitUntil` can be cancelled once the
 * response is sent, not just left to finish quietly in the background. This
 * module supplies that registration without threading a raw
 * `ExecutionContext` through every call site: Nitro's cloudflare preset
 * itself bolts `waitUntil` directly onto the platform `Request` object
 * (`node_modules/nitro/dist/presets/cloudflare/runtime/_module-handler.mjs`'s
 * `augmentReq`: `req.waitUntil = ctx.context?.waitUntil.bind(ctx.context)`)
 * specifically so downstream code can reach it this way — Nitro's own
 * internal code reads it the identical way (e.g.
 * `dev-tasks.mjs`: `event.req.waitUntil`), so this is the framework's
 * intended access pattern, not a workaround. `getRequestWaitUntil` is the
 * one place that reads it, matching this codebase's existing convention
 * (cloudflare-env.server.ts) of "just enough structural typing" rather than
 * depending on `@cloudflare/workers-types`.
 *
 * Outside Cloudflare (local `vite dev`, the Node test runner) `waitUntil`
 * is simply absent — `runInBackground` still lets the promise run to
 * completion un-awaited, which is safe there because those processes stay
 * alive on their own; the platform-specific risk this module guards against
 * doesn't exist in a plain long-running Node process.
 */

export type WaitUntil = (promise: Promise<unknown>) => void;

/** Reads the `waitUntil` Nitro's cloudflare preset attaches to the platform Request, or undefined outside Cloudflare. */
export function getRequestWaitUntil(request: Request): WaitUntil | undefined {
  return (request as { waitUntil?: WaitUntil }).waitUntil;
}

/**
 * Fires `promise` without making the caller wait on it. Registers it with
 * `waitUntil` when available (Cloudflare Workers) so the isolate isn't torn
 * down before it settles. A rejection is caught and logged under `logEvent`
 * — never thrown here (there is no caller left to catch it) and never left
 * as an unhandled rejection.
 */
export function runInBackground(
  promise: Promise<unknown>,
  waitUntil: WaitUntil | undefined,
  logEvent: string,
): void {
  const guarded = promise.catch((err: unknown) => {
    console.error(logEvent, (err as Error).message);
  });
  waitUntil?.(guarded);
}
