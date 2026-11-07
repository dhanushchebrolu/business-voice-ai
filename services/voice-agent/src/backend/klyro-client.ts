/**
 * Signed HTTPS client for klyro's internal voice-agent API
 * (src/lib/voice-agent/internal-auth.ts on the klyro side; the canonical
 * string below must stay byte-identical — cross-tested in
 * tests/klyro-client.spec.ts against klyro's own verifier).
 *
 * Reliability policy:
 *   - every request has a deadline (timeoutMs);
 *   - only requests the server treats idempotently are retried, with a new
 *     nonce each time (a nonce is single-use): session start (keyed by the
 *     SIP call id), availability, and booking (klyro keys a voice booking
 *     by call + slot, so a retry returns the same booking);
 *   - 4xx responses are never retried (the backend said no);
 *   - 429 / 5xx / network errors are retried with jittered backoff.
 */

export interface KlyroClientOptions {
  baseUrl: string;
  secret: string;
  keyId?: "current" | "previous";
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  /** For tests: deterministic clock/nonce. */
  now?: () => number;
}

export class KlyroError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, retryable: boolean) {
    super(`klyro ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function signKlyroRequest(p: {
  secret: string;
  keyId: "current" | "previous";
  method: string;
  path: string;
  body: string;
  nowSeconds: number;
  nonce: string;
}): Promise<Record<string, string>> {
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(p.body)));
  const canonical = [
    "v1",
    String(p.nowSeconds),
    p.nonce,
    p.method.toUpperCase(),
    p.path,
    bodyHash,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(p.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = hex(await crypto.subtle.sign("HMAC", key, enc.encode(canonical)));
  return {
    "x-clickai-key-id": p.keyId,
    "x-clickai-timestamp": String(p.nowSeconds),
    "x-clickai-nonce": p.nonce,
    "x-clickai-signature": `v1=${sig}`,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class KlyroClient {
  private readonly o: Required<Omit<KlyroClientOptions, "fetchImpl" | "now">> & {
    fetchImpl: typeof fetch;
    now: () => number;
  };

  constructor(o: KlyroClientOptions) {
    this.o = {
      baseUrl: o.baseUrl.replace(/\/+$/, ""),
      secret: o.secret,
      keyId: o.keyId ?? "current",
      timeoutMs: o.timeoutMs ?? 4000,
      retries: o.retries ?? 2,
      fetchImpl: o.fetchImpl ?? fetch,
      now: o.now ?? Date.now,
    };
  }

  async post<T>(path: string, payload: unknown, opts: { idempotent: boolean }): Promise<T> {
    const body = JSON.stringify(payload);
    const attempts = opts.idempotent ? this.o.retries + 1 : 1;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(Math.min(2000, 150 * 2 ** attempt) * (0.5 + Math.random() / 2));
      const headers = await signKlyroRequest({
        secret: this.o.secret,
        keyId: this.o.keyId,
        method: "POST",
        path,
        body,
        nowSeconds: Math.floor(this.o.now() / 1000),
        nonce: crypto.randomUUID().replace(/-/g, ""),
      });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
      try {
        const res = await this.o.fetchImpl(`${this.o.baseUrl}${path}`, {
          method: "POST",
          body,
          headers: { ...headers, "content-type": "application/json" },
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (res.ok) return JSON.parse(text) as T;
        let code = "http_error";
        try {
          code = (JSON.parse(text) as { error?: string }).error ?? code;
        } catch {
          /* non-JSON error body */
        }
        const retryable = res.status === 429 || res.status >= 500;
        last = new KlyroError(res.status, code, retryable);
        if (!retryable) throw last;
      } catch (e) {
        if (e instanceof KlyroError && !e.retryable) throw e;
        last =
          e instanceof KlyroError
            ? e
            : new KlyroError(0, ctrl.signal.aborted ? "timeout" : "network", true);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last instanceof KlyroError ? last : new KlyroError(0, "network", true);
  }
}
