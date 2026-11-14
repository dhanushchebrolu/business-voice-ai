import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { normalizeCustomerPhone } from "./phone-number.ts";
import type { DeploymentView } from "./provisioning-pipeline.server.ts";

/**
 * Updates the result-webhook URL (and so its verify_token) on ONE customer's
 * existing Sarvam deployment, for rotating SARVAM_WEBHOOK_SECRET, plus a
 * resume-only recovery for when that update left the deployment paused.
 *
 * Why a pause is involved: Sarvam's dashboard documentation says deployments
 * (including their webhook settings) can only be edited while paused, and a
 * live PATCH of an active deployment was refused on 2026-11-12 with "Only
 * paused deployments can be edited". So an ACTIVE deployment is paused for
 * the edit and resumed straight after; while it is paused Sarvam does not
 * answer calls to that number. This is a short, controlled interruption, not
 * zero downtime, and it happens only after an explicit confirmation.
 *
 * Durable recovery state: before ClickAI pauses an active deployment it
 * writes a recovery marker on the customer's own phone_numbers row
 * (metadata.sarvam_webhook_recovery, an existing jsonb column; compare-and-
 * swap on updated_at). The marker is the source of truth for "recovery
 * required", independent of audit logging: it survives a failed audit write,
 * a page reload and a Worker crash between pause and resume. It is cleared
 * only after Sarvam confirms the deployment is back in its original state
 * with the same agent, version and number. If the marker cannot be written,
 * nothing is paused; if it cannot be cleared, the result is never "rotated".
 *
 * Safety:
 *   - one customer, one number, one deployment; the deployment must be the
 *     one ClickAI recorded and must still route that number;
 *   - nothing is written when the deployment already carries the current
 *     token, when a pause is needed and was not confirmed, or while a
 *     recovery marker exists for that deployment;
 *   - the original paused/active state is restored on every path; if that
 *     cannot be confirmed the outcome is "recovery_required";
 *   - "rotated" is reported only after a read-back shows the current token,
 *     the original state and the same agent/version/number, and the marker
 *     has been cleared;
 *   - precondition refusals return a result instead of throwing, so the
 *     caller can audit every attempt;
 *   - the URL and token are never returned, logged or put in result text.
 */

type Admin = SupabaseClient<Database>;

export interface WebhookRotationDeps {
  /** Must classify the webhook token (webhookTokenStatus) — SarvamTelephonyAdapter.getDeployment does. */
  getDeployment: (deploymentId: string) => Promise<DeploymentView>;
  setDeploymentStatus: (deploymentId: string, action: "pause" | "resume") => Promise<unknown>;
  /** Documented PATCH webhook_config; the URL is built from the CURRENT secret. */
  updateWebhook: (
    deploymentId: string,
    webhook: { url: string; metadata: Record<string, string> },
  ) => Promise<unknown>;
  /** sarvamOutboundWebhookUrl(): the URL with the CURRENT token, or why it cannot be built. */
  webhookUrl: () => { ok: true; url: string } | { ok: false; reason: string };
  now?: () => Date;
}

/** Where an attempt stopped (recorded in the audit trail). */
export type RotationStage =
  | "precondition"
  | "persist"
  | "read_before"
  | "pause"
  | "update"
  | "resume"
  | "read_after"
  | "complete";

export type WebhookRotationOutcome =
  /** The deployment already carries the current token. Nothing written. */
  | "already_current"
  /** Active deployment and no explicit confirmation of the pause. Nothing written. */
  | "needs_confirmation"
  /** A precondition failed before any Sarvam write. Nothing written to Sarvam. */
  | "refused"
  /** Read back with the current token, original state and unchanged mapping; marker cleared. */
  | "rotated"
  /** Not completed; see detail. */
  | "failed"
  /** The deployment may not be in its original state: run the recovery. */
  | "recovery_required";

/** What the recovery needs to restore. */
export interface PendingRecovery {
  deploymentId: string;
  originalStatus: string;
  appId: string;
  appVersion: number | null;
}

/** The durable marker on the customer's phone_numbers row. */
export interface RecoveryMarker extends PendingRecovery {
  /** in_progress: ClickAI was about to pause / was mid-operation; recovery_required: confirmed not restored. */
  state: "in_progress" | "recovery_required";
  recordedAt: string;
}

export const RECOVERY_MARKER_KEY = "sarvam_webhook_recovery";

export interface WebhookRotationResult {
  outcome: WebhookRotationOutcome;
  stage: RotationStage;
  /** For the admin who ran it; already redacted. Not stored in the audit record. */
  detail: string;
  deploymentId: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
  tokenStatusBefore: string | null;
  tokenStatusAfter: string | null;
  appIdBefore: string | null;
  appVersionBefore: number | null;
  /** True when this run paused the deployment (it always attempts to resume it). */
  pausedByUs: boolean;
  /** The recovery owed (also persisted on the number row), when there is one. */
  recovery: PendingRecovery | null;
}

/** Strips anything token-shaped from text that may come from provider errors. */
export function redactWebhookSecrets(text: string): string {
  return text
    .replace(/(verify_token=)[^&"'\s]+/gi, "$1[redacted]")
    .replace(
      /https?:\/\/[^\s"']*\/api\/public\/webhooks\/telephony[^\s"']*/gi,
      "[webhook-url-redacted]",
    );
}

/** The recovery marker in a phone_numbers.metadata value, or null (validated). */
export function recoveryMarkerOf(metadata: unknown): RecoveryMarker | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = (metadata as Record<string, unknown>)[RECOVERY_MARKER_KEY];
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const v = m as Record<string, unknown>;
  if (typeof v["deploymentId"] !== "string" || typeof v["originalStatus"] !== "string") return null;
  return {
    deploymentId: v["deploymentId"],
    originalStatus: v["originalStatus"],
    appId: typeof v["appId"] === "string" ? v["appId"] : "",
    appVersion: typeof v["appVersion"] === "number" ? v["appVersion"] : null,
    state: v["state"] === "recovery_required" ? "recovery_required" : "in_progress",
    recordedAt: typeof v["recordedAt"] === "string" ? v["recordedAt"] : "",
  };
}

const canonical = (n: string) => normalizeCustomerPhone(n, null) ?? n;

interface OwnNumber {
  id: string;
  e164: string;
  organizationId: string;
  deploymentId: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

/**
 * The organization's one Sarvam number with a recorded deployment that no
 * other number shares, or the reason it cannot be used. Tenant scope comes
 * only from organizationId; nothing request-supplied picks the deployment.
 */
async function ownNumber(
  admin: Admin,
  organizationId: string,
): Promise<{ ok: true; number: OwnNumber } | { ok: false; detail: string }> {
  const { data: rows, error } = await admin
    .from("phone_numbers")
    .select(
      "id, e164, status, provider, organization_id, provider_deployment_id, metadata, updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("provider", "sarvam");
  if (error) throw error;
  const numbers = (rows ?? []).filter(
    (n) => n.status !== "released" && n.organization_id === organizationId,
  );
  if (numbers.length !== 1)
    return {
      ok: false,
      detail: `This customer has ${numbers.length} Sarvam numbers; this works only for exactly one. Nothing was changed.`,
    };
  const n = numbers[0]!;
  if (!n.provider_deployment_id)
    return {
      ok: false,
      detail: "This customer's number has no Sarvam deployment recorded. Nothing was changed.",
    };
  const { data: sharers, error: sharersError } = await admin
    .from("phone_numbers")
    .select("id, status")
    .eq("provider_deployment_id", n.provider_deployment_id);
  if (sharersError) throw sharersError;
  if ((sharers ?? []).some((s) => s.id !== n.id && s.status !== "released"))
    return {
      ok: false,
      detail:
        "This deployment is also recorded for another number; resolve that first. Nothing was changed.",
    };
  const metadata =
    n.metadata && typeof n.metadata === "object" && !Array.isArray(n.metadata)
      ? (n.metadata as Record<string, unknown>)
      : {};
  return {
    ok: true,
    number: {
      id: n.id,
      e164: n.e164,
      organizationId,
      deploymentId: n.provider_deployment_id,
      metadata,
      updatedAt: n.updated_at,
    },
  };
}

/**
 * Writes (marker) or clears (null) the recovery marker with a compare-and-
 * swap on updated_at, scoped to the customer's own row and deployment. Other
 * metadata keys are kept. Returns false when the write did not happen
 * (database error or the row changed meanwhile); never throws.
 */
async function writeMarker(
  admin: Admin,
  number: OwnNumber,
  marker: RecoveryMarker | null,
): Promise<boolean> {
  const next: Record<string, unknown> = { ...number.metadata };
  if (marker) next[RECOVERY_MARKER_KEY] = marker;
  else delete next[RECOVERY_MARKER_KEY];
  try {
    const { data, error } = await admin
      .from("phone_numbers")
      .update({ metadata: next as Json })
      .eq("id", number.id)
      .eq("organization_id", number.organizationId)
      .eq("provider_deployment_id", number.deploymentId)
      .eq("updated_at", number.updatedAt)
      .select("id, updated_at");
    if (error || !data || data.length !== 1) return false;
    number.metadata = next;
    number.updatedAt = data[0]!.updated_at;
    return true;
  } catch {
    return false;
  }
}

export async function rotateDeploymentWebhook(
  admin: Admin,
  input: { organizationId: string; confirmPause: boolean },
  deps: WebhookRotationDeps,
): Promise<WebhookRotationResult> {
  const now = deps.now ?? (() => new Date());
  const r: WebhookRotationResult = {
    outcome: "refused",
    stage: "precondition",
    detail: "",
    deploymentId: null,
    statusBefore: null,
    statusAfter: null,
    tokenStatusBefore: null,
    tokenStatusAfter: null,
    appIdBefore: null,
    appVersionBefore: null,
    pausedByUs: false,
    recovery: null,
  };
  const done = (
    outcome: WebhookRotationOutcome,
    stage: RotationStage,
    detail: string,
  ): WebhookRotationResult => ({ ...r, outcome, stage, detail });

  const own = await ownNumber(admin, input.organizationId);
  if (!own.ok) return done("refused", "precondition", own.detail);
  const { number } = own;
  const deploymentId = number.deploymentId;
  r.deploymentId = deploymentId;

  // A recovery marker for this deployment: an earlier attempt paused it and
  // never confirmed it was restored (or the Worker stopped mid-way).
  const existing = recoveryMarkerOf(number.metadata);
  if (existing && existing.deploymentId === deploymentId) {
    r.recovery = existing;
    return done(
      "recovery_required",
      "precondition",
      'An earlier webhook-token update may have left this deployment out of its original state. Run "Resume deployment" first; nothing was changed.',
    );
  }

  const webhook = deps.webhookUrl();
  if (!webhook.ok)
    return done(
      "refused",
      "precondition",
      `The ClickAI webhook URL cannot be built (${webhook.reason}); nothing was changed.`,
    );

  const read = async (): Promise<DeploymentView | null> => {
    try {
      return await deps.getDeployment(deploymentId);
    } catch {
      return null;
    }
  };

  const before = await read();
  if (!before)
    return done(
      "failed",
      "read_before",
      "Could not read the deployment from Sarvam; nothing was changed.",
    );
  r.statusBefore = before.status;
  r.tokenStatusBefore = before.webhookTokenStatus ?? null;
  r.appIdBefore = before.appId;
  r.appVersionBefore = before.appVersion;
  if (
    before.deploymentId !== deploymentId ||
    !before.phoneNumbers.map(canonical).includes(canonical(number.e164))
  )
    return done(
      "refused",
      "read_before",
      "Sarvam's deployment does not match ClickAI's record for this number; nothing was changed.",
    );
  if (before.webhookTokenStatus === undefined)
    return done(
      "refused",
      "read_before",
      "The deployment read did not classify the webhook token; nothing was changed.",
    );
  if (before.webhookTokenStatus === "current")
    return done(
      "already_current",
      "read_before",
      "The deployment already uses the current webhook token; nothing was changed.",
    );
  if (before.status !== "active" && before.status !== "paused")
    return done(
      "refused",
      "read_before",
      `The deployment is ${before.status ?? "in an unknown state"}; nothing was changed.`,
    );
  const wasActive = before.status === "active";
  if (wasActive && !input.confirmPause)
    return done(
      "needs_confirmation",
      "read_before",
      "The deployment is active: updating its webhook pauses it for a few seconds (calls are not answered meanwhile). Confirm the pause to continue; nothing was changed.",
    );

  const recovery: PendingRecovery = {
    deploymentId,
    originalStatus: before.status ?? "unknown",
    appId: before.appId,
    appVersion: before.appVersion,
  };
  const marker = (state: RecoveryMarker["state"]): RecoveryMarker => ({
    ...recovery,
    state,
    recordedAt: now().toISOString(),
  });

  // Durable marker BEFORE any pause: no marker, no pause.
  if (wasActive && !(await writeMarker(admin, number, marker("in_progress"))))
    return done(
      "refused",
      "persist",
      "ClickAI could not record the recovery marker (database error or a concurrent change), so the deployment was not paused. Nothing was changed; retry.",
    );

  // Pause (if active), edit, and always try to restore the original state.
  let editError: string | null = null;
  let resumeError: string | null = null;
  if (wasActive) {
    try {
      await deps.setDeploymentStatus(deploymentId, "pause");
      r.pausedByUs = true;
    } catch (err) {
      // A failed pause may still have taken effect: confirm the state.
      const nowState = await read();
      r.statusAfter = nowState?.status ?? null;
      r.tokenStatusAfter = nowState?.webhookTokenStatus ?? null;
      if (nowState?.status === before.status) {
        const cleared = await writeMarker(admin, number, null);
        return done(
          "failed",
          "pause",
          `Sarvam did not pause the deployment (${redactWebhookSecrets((err as Error).message)}); nothing was changed and it is still ${before.status}.${cleared ? "" : ' ClickAI could not clear its recovery marker: run "Resume deployment" to confirm and clear it.'}`,
        );
      }
      r.pausedByUs = true;
      r.recovery = recovery;
      await writeMarker(admin, number, marker("recovery_required"));
      return done(
        "recovery_required",
        "pause",
        `The pause request failed but the deployment is now ${nowState?.status ?? "in an unknown state"}, not ${before.status}. Run "Resume deployment".`,
      );
    }
  }
  try {
    await deps.updateWebhook(deploymentId, {
      url: webhook.url,
      metadata: { organization_id: input.organizationId },
    });
  } catch (err) {
    editError = redactWebhookSecrets((err as Error).message);
  }
  if (wasActive) {
    try {
      await deps.setDeploymentStatus(deploymentId, "resume");
    } catch (err) {
      resumeError = redactWebhookSecrets((err as Error).message);
    }
  }

  const after = await read();
  r.statusAfter = after?.status ?? null;
  r.tokenStatusAfter = after?.webhookTokenStatus ?? null;
  const stateRestored = after?.status === before.status;
  const mappingUnchanged =
    after !== null &&
    after.deploymentId === deploymentId &&
    after.appId === before.appId &&
    after.appVersion === before.appVersion &&
    after.phoneNumbers.map(canonical).includes(canonical(number.e164));

  // We changed its state and could not confirm it is back: recovery needed.
  // (The in_progress marker already makes it durable; upgrade it if we can.)
  if (r.pausedByUs && !(stateRestored && mappingUnchanged)) {
    r.recovery = recovery;
    await writeMarker(admin, number, marker("recovery_required"));
    return done(
      "recovery_required",
      resumeError ? "resume" : "read_after",
      `The deployment is ${after?.status ?? "in an unknown state (read-back failed)"}, not ${before.status} as before${resumeError ? ` (resume failed: ${resumeError})` : ""}. It may not be answering calls. Run "Resume deployment" now.`,
    );
  }

  // State is confirmed restored (or was never changed): clear the marker.
  const markerCleared = wasActive ? await writeMarker(admin, number, null) : true;
  if (!markerCleared) {
    r.recovery = recovery;
    return done(
      "failed",
      "persist",
      `Sarvam reports the deployment ${after?.status ?? "unknown"} as before${after?.webhookTokenStatus === "current" ? " with the current token" : ""}, but ClickAI could not clear its recovery marker. This is not marked complete: run "Resume deployment" to confirm the state and clear it.`,
    );
  }

  if (
    after &&
    after.webhookTokenStatus === "current" &&
    stateRestored &&
    mappingUnchanged &&
    !editError &&
    !resumeError
  )
    return done(
      "rotated",
      "complete",
      `The deployment now uses the current webhook token and is ${after.status} again, as before.`,
    );

  const problems = [
    editError ? `the webhook update failed (${editError})` : null,
    !after ? "the deployment could not be read back" : null,
    after && after.webhookTokenStatus !== "current"
      ? `the read-back token is ${after.webhookTokenStatus ?? "unclassified"}`
      : null,
    after && !stateRestored
      ? `it is ${after.status ?? "in an unknown state"}, not ${before.status}`
      : null,
    after && !mappingUnchanged ? "its agent, version or number differs from before" : null,
  ].filter(Boolean);
  return done(
    "failed",
    editError ? "update" : "read_after",
    `Not completed: ${problems.join("; ")}. The deployment is ${after?.status ?? "unknown"}, as before; the old token is still accepted while SARVAM_WEBHOOK_SECRET_PREVIOUS is set. Retry when ready.`,
  );
}

/** Audit actions, one per outcome (an internal error gets its own). */
export const ROTATION_AUDIT_ACTIONS: Record<WebhookRotationOutcome | "error", string> = {
  rotated: "SARVAM_WEBHOOK_TOKEN_UPDATED",
  already_current: "SARVAM_WEBHOOK_TOKEN_ALREADY_CURRENT",
  needs_confirmation: "SARVAM_WEBHOOK_TOKEN_UPDATE_NOT_CONFIRMED",
  refused: "SARVAM_WEBHOOK_TOKEN_UPDATE_REFUSED",
  failed: "SARVAM_WEBHOOK_TOKEN_UPDATE_FAILED",
  recovery_required: "SARVAM_WEBHOOK_TOKEN_RECOVERY_REQUIRED",
  error: "SARVAM_WEBHOOK_TOKEN_UPDATE_ERROR",
};

export type ResumeOutcome = "resumed" | "already_resumed" | "refused" | "failed";

export const RESUME_AUDIT_ACTIONS: Record<ResumeOutcome | "error", string> = {
  resumed: "SARVAM_DEPLOYMENT_RESUMED_AFTER_TOKEN_UPDATE",
  already_resumed: "SARVAM_DEPLOYMENT_ALREADY_ACTIVE_AFTER_TOKEN_UPDATE",
  refused: "SARVAM_DEPLOYMENT_RESUME_REFUSED",
  failed: "SARVAM_DEPLOYMENT_RESUME_FAILED",
  error: "SARVAM_DEPLOYMENT_RESUME_ERROR",
};

export interface ResumeResult {
  outcome: ResumeOutcome;
  stage: "precondition" | "read_before" | "resume" | "read_after" | "persist" | "complete";
  detail: string;
  deploymentId: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
  /** Whether the durable recovery marker was cleared (only after Sarvam confirmed). */
  markerCleared: boolean;
}

/** The pending recovery for an organization's number, from the durable marker (for the dashboard). */
export async function loadRecoveryMarker(
  admin: Admin,
  organizationId: string,
): Promise<RecoveryMarker | null> {
  const { data, error } = await admin
    .from("phone_numbers")
    .select("organization_id, provider, status, metadata")
    .eq("organization_id", organizationId)
    .eq("provider", "sarvam");
  if (error) throw error;
  for (const row of data ?? []) {
    if (row.organization_id !== organizationId || row.status === "released") continue;
    const m = recoveryMarkerOf(row.metadata);
    if (m) return m;
  }
  return null;
}

/**
 * Recovery for an update that may have left the deployment out of its
 * original state: resumes it, and only it, back to "active", then clears the
 * durable marker — only after Sarvam confirms the deployment is active with
 * the recorded agent, version and number. Refuses unless the recorded
 * original state was active and the deployment is this customer's one
 * recorded deployment. Idempotent: an already-active deployment is reported
 * (and its marker cleared), not touched.
 */
export async function resumeAfterFailedRotation(
  admin: Admin,
  input: { organizationId: string },
  deps: Pick<WebhookRotationDeps, "getDeployment" | "setDeploymentStatus">,
): Promise<ResumeResult> {
  const r: ResumeResult = {
    outcome: "refused",
    stage: "precondition",
    detail: "",
    deploymentId: null,
    statusBefore: null,
    statusAfter: null,
    markerCleared: false,
  };
  const done = (
    outcome: ResumeOutcome,
    stage: ResumeResult["stage"],
    detail: string,
  ): ResumeResult => ({ ...r, outcome, stage, detail });

  const own = await ownNumber(admin, input.organizationId);
  if (!own.ok) return done("refused", "precondition", own.detail);
  const { number } = own;
  r.deploymentId = number.deploymentId;
  const recovery = recoveryMarkerOf(number.metadata);
  if (!recovery)
    return done(
      "refused",
      "precondition",
      "No webhook-token update is waiting for recovery for this customer.",
    );
  if (recovery.deploymentId !== number.deploymentId)
    return done(
      "refused",
      "precondition",
      "The recorded recovery is for a different deployment than this customer's current one; check it by hand. Nothing was changed.",
    );
  if (recovery.originalStatus !== "active")
    return done(
      "refused",
      "precondition",
      `The deployment was ${recovery.originalStatus} before the update, so it is not resumed automatically; check it in the Sarvam console.`,
    );

  const read = async (): Promise<DeploymentView | null> => {
    try {
      return await deps.getDeployment(number.deploymentId);
    } catch {
      return null;
    }
  };
  const sameMapping = (d: DeploymentView) =>
    d.deploymentId === number.deploymentId &&
    d.appId === recovery.appId &&
    d.appVersion === recovery.appVersion &&
    d.phoneNumbers.map(canonical).includes(canonical(number.e164));
  const confirmAndClear = async (d: DeploymentView, outcome: "resumed" | "already_resumed") => {
    r.statusAfter = d.status;
    r.markerCleared = await writeMarker(admin, number, null);
    if (!r.markerCleared)
      return done(
        "failed",
        "persist",
        'Sarvam confirms the deployment is active with the same agent, version and number, but ClickAI could not clear its recovery marker. Retry "Resume deployment".',
      );
    return done(
      outcome,
      "complete",
      outcome === "resumed"
        ? "The deployment is active again with the same agent, version and number."
        : "The deployment is already active with the same agent, version and number; recovery cleared.",
    );
  };

  const before = await read();
  if (!before)
    return done(
      "failed",
      "read_before",
      "Could not read the deployment from Sarvam; nothing was changed.",
    );
  r.statusBefore = before.status;
  if (!sameMapping(before))
    return done(
      "refused",
      "read_before",
      "Sarvam shows a different agent, version or number than before the update; not resumed. Check it in the Sarvam console.",
    );
  if (before.status === "active") return confirmAndClear(before, "already_resumed");
  if (before.status !== "paused")
    return done(
      "refused",
      "read_before",
      `The deployment is ${before.status ?? "in an unknown state"}; not resumed.`,
    );

  let resumeError: string | null = null;
  try {
    await deps.setDeploymentStatus(number.deploymentId, "resume");
  } catch (err) {
    resumeError = redactWebhookSecrets((err as Error).message);
  }
  const after = await read();
  r.statusAfter = after?.status ?? null;
  if (after && after.status === "active" && sameMapping(after))
    return confirmAndClear(after, "resumed");
  return done(
    "failed",
    resumeError ? "resume" : "read_after",
    `Not resumed${resumeError ? ` (${resumeError})` : ""}: it is ${after?.status ?? "unknown"}. The recovery marker is kept; retry, or resume it in the Sarvam console and then run "Resume deployment" to clear it.`,
  );
}
