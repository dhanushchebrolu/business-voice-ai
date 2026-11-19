/** Harness only: server functions are plain async functions here (fake-outbound-functions.ts). */
export const useServerFn = <T>(fn: T): T => fn;
