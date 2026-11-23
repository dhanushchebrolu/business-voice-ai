/**
 * The idempotency key of one campaign-creation session (the create wizard).
 *
 * - Kept in sessionStorage, so a refresh or a retry after a timeout sends the
 *   same key and the server returns the campaign it already created
 *   (campaigns.idempotency_key, unique per organization).
 * - Released when the wizard is left in the app (saved, cancelled or
 *   navigated away), so the next wizard is a new creation with a new key. A
 *   refresh does not unmount the wizard, so the key survives it.
 * - sessionStorage is per tab: two tabs are two creation sessions.
 * - Storage may be unavailable (private mode, blocked site data): the key
 *   then lives only in memory for this wizard and nothing throws.
 */

export const CAMPAIGN_CREATE_KEY_STORAGE = "clickai.campaign-create-key";
/** Same shape as the outbound request keys (sarvam-outbound-call.server.ts). */
export const CAMPAIGN_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let pendingRelease: ReturnType<typeof setTimeout> | null = null;

export function newCampaignCreateKey(): string {
  return `cmp_${crypto.randomUUID().replace(/-/g, "")}`;
}

function sessionStore(): KeyStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** This session's key: the stored one if valid, otherwise a new one (stored when possible). */
export function claimCampaignCreateKey(storage: KeyStorage | null = sessionStore()): string {
  // A remount right after an unmount (same wizard) keeps its key.
  if (pendingRelease) {
    clearTimeout(pendingRelease);
    pendingRelease = null;
  }
  try {
    const stored = storage?.getItem(CAMPAIGN_CREATE_KEY_STORAGE);
    if (stored && CAMPAIGN_IDEMPOTENCY_KEY_PATTERN.test(stored)) return stored;
  } catch {
    // unreadable storage: fall through to a fresh key
  }
  const key = newCampaignCreateKey();
  try {
    storage?.setItem(CAMPAIGN_CREATE_KEY_STORAGE, key);
  } catch {
    // unwritable storage: the key still protects retries within this wizard
  }
  return key;
}

/** Keeps `key` as this tab's creation key while the wizard is open (cancels a pending release). */
export function holdCampaignCreateKey(
  key: string,
  storage: KeyStorage | null = sessionStore(),
): void {
  if (pendingRelease) {
    clearTimeout(pendingRelease);
    pendingRelease = null;
  }
  try {
    storage?.setItem(CAMPAIGN_CREATE_KEY_STORAGE, key);
  } catch {
    // unwritable storage: the in-memory key still protects retries within this wizard
  }
}

/** Ends the creation session, so the next wizard gets a new key. Deferred one tick (see claim). */
export function releaseCampaignCreateKey(storage: KeyStorage | null = sessionStore()): void {
  if (pendingRelease) clearTimeout(pendingRelease);
  pendingRelease = setTimeout(() => {
    pendingRelease = null;
    try {
      storage?.removeItem(CAMPAIGN_CREATE_KEY_STORAGE);
    } catch {
      // nothing to clean up if storage is unavailable
    }
  }, 0);
}
