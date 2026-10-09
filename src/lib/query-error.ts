/**
 * Turns a thrown/query error into a short, user-facing message, consistent
 * across every page's ErrorState. Server functions and RPC-error mappings
 * throughout this codebase already throw deliberately friendly `Error`
 * messages (e.g. booking-service.server.ts's BookingError, "That business
 * does not belong to your workspace."), so `error.message` is safe to show
 * as-is — this only adds the one new case the shared request-timeout
 * (client.ts / client.server.ts / auth-middleware.ts) introduces: a fetch
 * aborted for taking too long, which must not read as a generic failure or
 * imply any database write/booking definitely didn't happen.
 */
export function describeQueryError(
  error: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "This is taking longer than expected. The network or server may be slow right now — please try again.";
    }
    if (error.message) return error.message;
  }
  return fallback;
}
