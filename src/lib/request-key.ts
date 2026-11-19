/**
 * A request id for one outbound-call attempt. The browser keeps it for the
 * attempt, so a double click, a retry after a timeout or a resubmission sends
 * the same id and the server returns the same call instead of dialling again
 * (admit_single_outbound_call). Replace it only after a success, or when the
 * server says that attempt can no longer be used.
 */
export function newRequestKey(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** The server's answer when a request id belongs to an attempt that was not placed. */
export const REQUEST_KEY_SPENT_MESSAGE = "This call was not placed. Start a new call to try again.";
