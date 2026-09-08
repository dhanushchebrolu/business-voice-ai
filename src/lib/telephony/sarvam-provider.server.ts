import {
  TelephonyAdapterError,
  type CallTranscriptTurn,
  type InitiateOutboundCallInput,
  type InitiatedCall,
  type NormalizedCallEvent,
  type NormalizedCallStatus,
  type ProvisionNumberInput,
  type ProvisionedNumber,
  type TelephonyProviderAdapter,
} from "./adapter.ts";

/**
 * Sarvam-managed-telephony adapter — Sarvam Voice Agents.
 *
 * VERIFICATION STATUS (read before touching this file): this environment's
 * network egress is blocked to docs.sarvam.ai (confirmed via direct fetch,
 * the documented `.md`-suffix route, and llms.txt — all same host, all
 * denied by the organization's egress policy; the proxy's own guidance is
 * not to route around a policy denial). What IS implemented below is
 * limited strictly to what the calling session verified from Sarvam's own
 * documentation and supplied directly (see the migration report for the
 * full verified/unverified breakdown) — nothing here is guessed.
 *
 * VERIFIED and implemented for real:
 *   - Inbound completion webhook payload fields: app_id, app_version,
 *     deployment_id, interaction_id, user_phone_number, agent_phone_number,
 *     duration, final_agent_variables, output_agent_variables,
 *     start_datetime, end_datetime, interaction_transcript (array of
 *     {role, en_text, indic_text?}), metadata. Sent once, after an inbound
 *     call finishes.
 *   - Outbound campaign attempt webhook payload fields: app_id, app_version,
 *     attempt_id, campaign_id, cohort_id, completion_status,
 *     connectivity_status, next_action_status, failure_reason,
 *     user_identifier, user_phone_number, agent_phone_number, duration,
 *     interaction_id, retry_attempt, executed_at, start_datetime,
 *     end_datetime, initial_agent_variables, final_agent_variables,
 *     output_agent_variables, interaction_transcript, metadata. Sent after
 *     EVERY attempt, including ones that never connected.
 *   - Authentication: Sarvam's API-wide `api-subscription-key` header
 *     mechanism (Bearer also accepted) — the same one `sarvam.server.ts`
 *     already uses for chat/STT/TTS — is confirmed to cover this surface
 *     too. No second credential is introduced; see telephony.server.ts's
 *     `sarvam` branch, which reuses `SARVAM_API_KEY`.
 *
 * NOT verified, and deliberately NOT implemented (each throws or fails
 * closed with an explicit message rather than guessing):
 *   - Voice Agent create/update endpoint (request path, method, body).
 *   - Phone-number rental/provisioning endpoint.
 *   - Inbound deployment create/update endpoint (routing a number to an
 *     agent).
 *   - Outbound campaign creation endpoint/request body — including,
 *     critically, which field (if any) lets Klyro attach its own
 *     client-reference to a recipient so it round-trips on the webhook.
 *   - Instant-outbound call creation endpoint/request body.
 *   - The webhook authentication/signature mechanism itself — Sarvam's docs
 *     were not reachable to confirm a header name or algorithm, so
 *     `verifyWebhookSignature` below FAILS CLOSED (always rejects) until a
 *     real mechanism is confirmed and implemented. This is a deliberate
 *     safety choice, not an oversight: accepting an unverified webhook as
 *     authentic would be worse than rejecting a real one.
 *
 * Two further inferences made here are heuristic, not verified, and are
 * called out at their point of use below: (1) the exact string values
 * `completion_status`/`connectivity_status` take (only the field *names*
 * are verified) are classified defensively by substring match, never
 * assumed; (2) which of `user_identifier` / `metadata` actually carries a
 * Klyro-supplied client-reference on an outbound attempt is unconfirmed
 * (because the campaign-creation request body — where such a reference
 * would be supplied — is itself unverified), so both are surfaced as
 * *candidates* via `clientReference`, never trusted as authorization by
 * themselves (see adapter.ts's `clientReference` doc and the webhook
 * route's tenant-resolution logic, which only ever uses it to look up a
 * Klyro-owned record — never to construct or accept an organization_id).
 */

export interface SarvamTelephonyConfig {
  apiKey: string;
  /**
   * Sarvam org/workspace scope, read from SARVAM_ORG_ID/SARVAM_WORKSPACE_ID
   * when present. Optional here — the webhook-processing path
   * (verifyWebhookSignature/normalizeWebhookEvent) needs neither, so their
   * absence must never break that already-working path. Only
   * createInboundDeployment (and, eventually, campaign/instant-outbound
   * calls) require them, and check for them explicitly at call time.
   */
  orgId?: string | undefined;
  workspaceId?: string | undefined;
}

/**
 * Request/response shapes for POST .../deployments, as supplied and
 * cross-checked against this session's independently-verified inbound
 * webhook payload fields (app_id, deployment_id, etc. match exactly) — see
 * the module doc's VERIFICATION STATUS section. The endpoint itself
 * (path, method, and critically the X-API-Key auth header) has NOT been
 * independently fetched or empirically confirmed by this session; treat
 * this shape as PARTIALLY VERIFIED, not proven, until a real request
 * succeeds against it.
 */
export interface CreateInboundDeploymentInput {
  name: string;
  description?: string | undefined;
  appId: string;
  appVersion: number;
  connectionId: string;
  /** E.164 numbers this deployment routes to the agent. */
  phoneNumbers: string[];
  inboundConfig?:
    | {
        startTime: string;
        endTime: string;
        allowedDays: string[];
        timezone: string;
      }
    | undefined;
}

export interface CreatedDeployment {
  deploymentId: string;
}

/**
 * Sarvam's webhook authentication/signature mechanism is unverified in this
 * environment (see the module doc above). Exported so callers and tests can
 * assert the fail-closed state explicitly, and so there is exactly one flag
 * to flip once a real mechanism is confirmed and `verifyWebhookSignature`
 * below is implemented against it.
 */
export const SARVAM_WEBHOOK_AUTH_VERIFIED = false;

const OUTBOUND_ONLY_FIELDS = [
  "campaign_id",
  "attempt_id",
  "completion_status",
  "connectivity_status",
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function asPlainObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function toIsoOrNow(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (isNonEmptyString(c)) {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return new Date().toISOString();
}

function toDurationSeconds(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Never throws — a malformed turn is dropped, not fatal to the whole transcript. */
function parseTranscript(raw: unknown): CallTranscriptTurn[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const turns: CallTranscriptTurn[] = [];
  for (const entry of raw) {
    const obj = asPlainObject(entry);
    if (!obj) continue;
    const role = obj["role"];
    const text = obj["en_text"];
    if (role !== "agent" && role !== "user") continue;
    if (!isNonEmptyString(text)) continue;
    const indicText = obj["indic_text"];
    turns.push({ role, text, indicText: isNonEmptyString(indicText) ? indicText : undefined });
  }
  return turns;
}

/**
 * Keeps `initial`/`final`/`output` agent-variable snapshots distinct rather
 * than merging them — the three fields' exact semantic relationship (does
 * `output` supersede `final`? do they ever disagree?) is not documented
 * anywhere this session could verify, so nothing is discarded or silently
 * overwritten on a key collision.
 */
function collectAgentVariables(
  initial: unknown,
  final: unknown,
  output: unknown,
): Record<string, unknown> | undefined {
  const initialObj = asPlainObject(initial);
  const finalObj = asPlainObject(final);
  const outputObj = asPlainObject(output);
  if (!initialObj && !finalObj && !outputObj) return undefined;
  const result: Record<string, unknown> = {};
  if (initialObj) result["initial"] = initialObj;
  if (finalObj) result["final"] = finalObj;
  if (outputObj) result["output"] = outputObj;
  return result;
}

/**
 * HEURISTIC, not verified: only the field names `completion_status` and
 * `connectivity_status` are confirmed to exist; their exact string values
 * are not. Classifies defensively by substring match and never throws on an
 * unrecognized value. An attempt that cannot be confidently classified as
 * "completed" defaults to "failed" — the safe direction for billing (an
 * attempt this code does not understand must never be billed as a
 * successfully completed call).
 */
function classifyOutboundStatus(
  completionStatus: unknown,
  connectivityStatus: unknown,
): NormalizedCallStatus {
  const completion = isNonEmptyString(completionStatus) ? completionStatus.toLowerCase() : "";
  const connectivity = isNonEmptyString(connectivityStatus) ? connectivityStatus.toLowerCase() : "";
  const combined = `${completion} ${connectivity}`;

  if (/busy/.test(combined)) return "busy";
  if (/no.?answer|unanswered|not.?answered/.test(combined)) return "no_answer";
  if (/cancel/.test(combined)) return "cancelled";
  if (/fail|error|invalid|reject|not.?connect|disconnect|voicemail/.test(combined)) return "failed";
  if (/complet|success|connected/.test(combined)) return "completed";
  return "failed";
}

/** Best-effort candidate client-reference — see the module doc's note on `clientReference`. */
function extractClientReference(fields: Record<string, unknown>): string | undefined {
  const userIdentifier = fields["user_identifier"];
  if (isNonEmptyString(userIdentifier)) return userIdentifier;
  const metadata = fields["metadata"];
  if (isNonEmptyString(metadata)) return metadata;
  return undefined;
}

export class SarvamTelephonyAdapter implements TelephonyProviderAdapter {
  id = "sarvam";
  // Sarvam rents/manages numbers directly (verified: no external telephony
  // provider is required) — true of the provider's capability. provisionNumber
  // itself still throws below until the exact rental endpoint is verified;
  // this flag describes what Sarvam supports, not what this adapter has
  // implemented yet.
  supportsPurchase = true;

  private config: SarvamTelephonyConfig;

  constructor(config: SarvamTelephonyConfig) {
    this.config = config;
  }

  async provisionNumber(_input: ProvisionNumberInput): Promise<ProvisionedNumber> {
    throw new TelephonyAdapterError(
      "Sarvam phone-number rental is not implemented: the exact rental/provisioning endpoint has not been verified against Sarvam's official documentation in this environment. Confirm it against docs.sarvam.ai (or Sarvam support) before implementing — do not guess it.",
      501,
    );
  }

  async releaseNumber(_providerNumberId: string): Promise<void> {
    throw new TelephonyAdapterError(
      "Sarvam number release is not implemented: the exact release/deprovisioning endpoint has not been verified. Confirm it against Sarvam's documentation before implementing — do not guess it.",
      501,
    );
  }

  async initiateOutboundCall(_input: InitiateOutboundCallInput): Promise<InitiatedCall> {
    throw new TelephonyAdapterError(
      "Sarvam outbound dialing is not implemented here: outbound calls on Sarvam are campaign/instant-outbound-shaped, not a single 'dial and get a call ID back' REST call, and neither the campaign-creation nor instant-outbound-creation request schema has been verified against Sarvam's official documentation (including whether/how a Klyro client-reference can be attached to a recipient). Confirm the real request shape before implementing — do not guess it.",
      501,
    );
  }

  /**
   * Creates a Sarvam inbound deployment (routes a phone number to a Voice
   * Agent). NOT IMPLEMENTED — deliberately fails closed rather than
   * guessing, for two independent, stacked reasons that must BOTH resolve
   * before this can call Sarvam for real:
   *
   *   1. The `X-API-Key` header shown in the Voice Agents management API
   *      reference has not been empirically confirmed against a live
   *      response — this session has no SARVAM_API_KEY and no network path
   *      to apps.sarvam.ai from its sandbox (confirmed blocked at the
   *      proxy level, independent of credentials).
   *   2. Even with (1) resolved, this method has never actually issued the
   *      request — nothing here should be trusted as "implemented" until
   *      it has been exercised against a real response, success or error.
   *
   * Callers (sarvam-admin.functions.ts's createSarvamInboundDeployment) are
   * expected to perform ALL of their own validation (tenant ownership,
   * that the referenced agent/connection/numbers are actually mapped)
   * before ever reaching this call, so that everything up to the Sarvam
   * request itself is real, tested, working code — only the actual network
   * call is gated.
   */
  async createInboundDeployment(_input: CreateInboundDeploymentInput): Promise<CreatedDeployment> {
    if (!this.config.orgId || !this.config.workspaceId) {
      throw new TelephonyAdapterError(
        "Sarvam inbound deployment creation requires SARVAM_ORG_ID and SARVAM_WORKSPACE_ID to be configured, in addition to SARVAM_API_KEY.",
        503,
      );
    }
    throw new TelephonyAdapterError(
      "Sarvam inbound deployment creation is not implemented: the X-API-Key authentication mechanism documented for this endpoint has not been empirically verified against a live apps.sarvam.ai response in this environment (no live credentials, and apps.sarvam.ai is network-unreachable from this sandbox regardless). Verify a real request/response first — do not fake a successful deployment.",
      501,
    );
  }

  /**
   * FAILS CLOSED: Sarvam's webhook authentication/signature mechanism is
   * unverified in this environment (see the module doc above), so every
   * request is rejected until this is replaced with a real check against
   * the documented mechanism. This is intentional — see
   * SARVAM_WEBHOOK_AUTH_VERIFIED.
   */
  verifyWebhookSignature(
    _rawBody: string,
    _headers: Record<string, string | null>,
    _url?: URL,
  ): boolean {
    return SARVAM_WEBHOOK_AUTH_VERIFIED;
  }

  normalizeWebhookEvent(rawBody: string): NormalizedCallEvent | null {
    let fields: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      const obj = asPlainObject(parsed);
      if (!obj) return null;
      fields = obj;
    } catch {
      return null;
    }

    const interactionId = fields["interaction_id"];
    if (!isNonEmptyString(interactionId)) return null;

    const isOutbound = OUTBOUND_ONLY_FIELDS.some((key) => fields[key] !== undefined);

    const userPhoneNumber = fields["user_phone_number"];
    const agentPhoneNumber = fields["agent_phone_number"];
    const durationSeconds = toDurationSeconds(fields["duration"]);
    const transcript = parseTranscript(fields["interaction_transcript"]);
    const clientReference = extractClientReference(fields);

    if (isOutbound) {
      const status = classifyOutboundStatus(
        fields["completion_status"],
        fields["connectivity_status"],
      );
      const agentVariables = collectAgentVariables(
        fields["initial_agent_variables"],
        fields["final_agent_variables"],
        fields["output_agent_variables"],
      );
      return {
        eventId: isNonEmptyString(fields["attempt_id"]) ? fields["attempt_id"] : interactionId,
        providerCallId: interactionId,
        status,
        direction: "outbound",
        vaaniE164: isNonEmptyString(agentPhoneNumber) ? agentPhoneNumber : undefined,
        fromE164: isNonEmptyString(agentPhoneNumber) ? agentPhoneNumber : undefined,
        toE164: isNonEmptyString(userPhoneNumber) ? userPhoneNumber : undefined,
        durationSeconds,
        recordingUrl: null,
        failureReason: isNonEmptyString(fields["failure_reason"]) ? fields["failure_reason"] : null,
        occurredAt: toIsoOrNow(
          fields["end_datetime"],
          fields["executed_at"],
          fields["start_datetime"],
        ),
        transcript,
        agentVariables,
        providerCampaignId: isNonEmptyString(fields["campaign_id"])
          ? fields["campaign_id"]
          : undefined,
        providerAttemptId: isNonEmptyString(fields["attempt_id"])
          ? fields["attempt_id"]
          : undefined,
        clientReference,
        raw: fields,
      };
    }

    // Inbound completion webhook — sent once, after the call finishes, with
    // no separate status field (verified field list above), so every
    // recognized inbound event is a "completed" terminal event.
    const agentVariables = collectAgentVariables(
      undefined,
      fields["final_agent_variables"],
      fields["output_agent_variables"],
    );
    return {
      eventId: interactionId,
      providerCallId: interactionId,
      status: "completed",
      direction: "inbound",
      vaaniE164: isNonEmptyString(agentPhoneNumber) ? agentPhoneNumber : undefined,
      fromE164: isNonEmptyString(userPhoneNumber) ? userPhoneNumber : undefined,
      toE164: isNonEmptyString(agentPhoneNumber) ? agentPhoneNumber : undefined,
      durationSeconds,
      recordingUrl: null,
      failureReason: null,
      occurredAt: toIsoOrNow(fields["end_datetime"], fields["start_datetime"]),
      transcript,
      agentVariables,
      providerDeploymentId: isNonEmptyString(fields["deployment_id"])
        ? fields["deployment_id"]
        : undefined,
      clientReference,
      raw: fields,
    };
  }

  // No openMediaBridge: Sarvam's own runtime handles the entire call
  // (telephony + STT + LLM + TTS) end-to-end. Klyro never bridges live call
  // audio for a call placed through Sarvam-managed telephony, so there is no
  // media channel for this adapter to open — omitting the (optional) method
  // is the correct, self-documenting way to express that, matching how every
  // other adapter in this codebase without live media support already omits
  // it (see generic-provider.ts, mock-provider.ts).
}
