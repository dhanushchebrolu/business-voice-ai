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
import {
  createDeployment as apiCreateDeployment,
  createInstantOutbound as apiCreateInstantOutbound,
  getCampaign as apiGetCampaign,
  listCampaigns as apiListCampaigns,
  updateCampaign as apiUpdateCampaign,
  updateDeployment as apiUpdateDeployment,
  type CreateInstantOutboundInput,
  type InstantOutboundResult,
  type SarvamApiClientConfig,
  type SarvamCampaign,
  type UpdateCampaignInput,
  type UpdateDeploymentInput,
} from "./sarvam-api-client.server.ts";
import { constantTimeEquals } from "../constant-time-equals.server.ts";

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
 * MANAGEMENT API CALLS — code exists and constructs a real HTTP request
 * against the endpoint paths supplied directly in this conversation as
 * already-verified/documented API contracts, using sarvam-api-client.server.ts
 * (see that file's own module doc for exactly which parts of each request/
 * response shape are verified vs. best-effort). Per explicit instruction,
 * NONE of these has ever been exercised against a live Sarvam response in
 * this environment (no live SARVAM_API_KEY has been available, and
 * apps.sarvam.ai is network-unreachable from this sandbox independent of
 * credentials) — "code exists and sends a request" is NOT the same claim as
 * "confirmed working," and no deployment/campaign/interaction ID is ever
 * fabricated when the call fails or is unreachable:
 *   - createInboundDeployment / updateInboundDeployment — POST/PATCH
 *     .../deployments.
 *   - listCampaigns / getCampaign / updateCampaign — GET/GET/PATCH
 *     .../campaigns (only the GET list path itself was given verbatim as a
 *     read-only test target; the id-scoped and PATCH paths follow the same
 *     convention, not independently confirmed).
 *   - createInstantOutbound — POST .../outbounds. interaction_id is NOT
 *     confirmed to be returned synchronously; callers must handle its
 *     absence and rely on the webhook (or the existing clientReference
 *     fallback) to learn it.
 *
 * NOT verified, and deliberately NOT implemented (each throws or fails
 * closed with an explicit message rather than guessing):
 *   - Voice Agent create/update endpoint (request path, method, body).
 *   - Phone-number rental/provisioning endpoint.
 *   - Campaign *creation* (only list/get/update are implemented — creation
 *     was explicitly out of scope for this phase).
 *   - The webhook authentication/signature mechanism itself — Sarvam's docs
 *     were not reachable to confirm a header name or algorithm (re-confirmed
 *     during Phase 5: a live fetch to docs.sarvam.ai from this environment
 *     still returns EGRESS_BLOCKED), so `verifyWebhookSignature` below FAILS
 *     CLOSED against Sarvam's own mechanism (SARVAM_WEBHOOK_AUTH_VERIFIED
 *     stays false) until a real mechanism is confirmed and implemented. This
 *     is a deliberate safety choice, not an oversight: accepting an
 *     unverified webhook as authentic would be worse than rejecting a real
 *     one. Phase 5 adds one optional, strictly weaker defense-in-depth layer
 *     on top: when an operator configures SARVAM_WEBHOOK_SECRET, the request
 *     is also accepted if it carries a matching `verify_token` query
 *     parameter — a Klyro-generated shared secret embedded in the exact
 *     webhook URL Klyro configures into the Sarvam deployment, mirroring the
 *     existing Exotel `verify_token` mechanism (exotel-provider.ts). This
 *     proves the caller knows Klyro's private URL, not that Sarvam's servers
 *     produced the request — see verifyWebhookSignature's own doc comment.
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
  /**
   * Optional Klyro-generated shared secret for the defense-in-depth
   * `verify_token` query-parameter check described in the module doc. Unset
   * by default (matching every environment before Phase 5) — when absent,
   * `verifyWebhookSignature` behaves exactly as before: fails closed
   * unconditionally.
   */
  webhookSecret?: string | undefined;
  /** Injectable for tests — passed straight through to sarvam-api-client.server.ts. Defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
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

/**
 * Loose E.164 shape check (leading +, country code, 7-15 digits total) —
 * good enough to reject an obviously malformed phone-number field (spec
 * Phase 5 §5: "Reject malformed phone numbers") without pretending to
 * validate real dialability. A field that fails this check is treated as
 * absent (undefined) rather than passed through: the webhook route's
 * existing "unknown number" fallback then drops the event safely instead of
 * attempting a lookup with garbage input.
 */
const E164_RE = /^\+[1-9]\d{6,14}$/;
function isPlausibleE164(v: unknown): v is string {
  return typeof v === "string" && E164_RE.test(v);
}

/**
 * Caps on transcript size (spec Phase 5 §5: "Limit transcript/metadata
 * sizes if appropriate to prevent abuse"). Generous enough for any
 * realistic call (a 2000-turn/20000-char-per-turn conversation is already
 * far longer than any real phone call), so no legitimate transcript is
 * truncated in practice — this exists only to bound how much an
 * unauthenticated-until-verified payload can force into call_logs.transcript.
 */
const MAX_TRANSCRIPT_TURNS = 2000;
const MAX_TRANSCRIPT_TEXT_LENGTH = 20000;

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
    if (turns.length >= MAX_TRANSCRIPT_TURNS) break;
    const obj = asPlainObject(entry);
    if (!obj) continue;
    const role = obj["role"];
    const text = obj["en_text"];
    if (role !== "agent" && role !== "user") continue;
    if (!isNonEmptyString(text)) continue;
    const indicText = obj["indic_text"];
    turns.push({
      role,
      text: text.slice(0, MAX_TRANSCRIPT_TEXT_LENGTH),
      indicText: isNonEmptyString(indicText)
        ? indicText.slice(0, MAX_TRANSCRIPT_TEXT_LENGTH)
        : undefined,
    });
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
      "Sarvam outbound dialing does not fit this shared interface: outbound calls on Sarvam are campaign/instant-outbound-shaped, not a single 'dial and get a call ID back' REST call, and InitiatedCall.providerCallId is non-optional while Sarvam's instant-outbound response is not confirmed to return interaction_id synchronously. Use createInstantOutbound (Sarvam-specific, below) instead of this shared method.",
      501,
    );
  }

  /** Scopes the Voice Agents management API client config, or fails closed if org/workspace isn't configured. */
  private managementApiConfig(): SarvamApiClientConfig {
    if (!this.config.orgId || !this.config.workspaceId) {
      throw new TelephonyAdapterError(
        "This operation requires SARVAM_ORG_ID and SARVAM_WORKSPACE_ID to be configured, in addition to SARVAM_API_KEY.",
        503,
      );
    }
    return {
      apiKey: this.config.apiKey,
      orgId: this.config.orgId,
      workspaceId: this.config.workspaceId,
      fetchImpl: this.config.fetchImpl,
    };
  }

  /**
   * Creates a Sarvam inbound deployment (routes a phone number to a Voice
   * Agent). Sends a real POST request via sarvam-api-client.server.ts — see
   * that file's and this module's doc comments for exactly which parts of
   * the request/response shape are verified vs. best-effort. This has never
   * been exercised against a live Sarvam response in this environment (no
   * live SARVAM_API_KEY has been available, and apps.sarvam.ai is
   * network-unreachable from this sandbox independent of credentials) — if
   * it fails here, that failure is real and propagated, never swallowed
   * into a fake success.
   *
   * Callers (sarvam-admin.functions.ts's createSarvamInboundDeployment) are
   * expected to perform ALL of their own validation (tenant ownership,
   * that the referenced agent/connection/numbers are actually mapped)
   * before ever reaching this call.
   */
  async createInboundDeployment(input: CreateInboundDeploymentInput): Promise<CreatedDeployment> {
    const result = await apiCreateDeployment(this.managementApiConfig(), input);
    return { deploymentId: result.deploymentId };
  }

  /**
   * Updates an existing Sarvam inbound deployment (e.g. its phone-number set
   * or inbound schedule). Same verification status as createInboundDeployment
   * above — a real PATCH request, never exercised against a live response.
   */
  async updateInboundDeployment(
    deploymentId: string,
    input: UpdateDeploymentInput,
  ): Promise<CreatedDeployment> {
    const result = await apiUpdateDeployment(this.managementApiConfig(), deploymentId, input);
    return { deploymentId: result.deploymentId };
  }

  /**
   * Campaign adapter/server boundary only (per instruction — no campaign UI
   * this phase). Same verification status as the deployment methods: real
   * requests, never exercised live. listCampaigns/getCampaign use the
   * verified GET .../campaigns path family; updateCampaign's PATCH path and
   * body are the same convention, not independently confirmed.
   */
  async listCampaigns(): Promise<SarvamCampaign[]> {
    const result = await apiListCampaigns(this.managementApiConfig());
    return result.campaigns;
  }

  async getCampaign(campaignId: string): Promise<SarvamCampaign> {
    return apiGetCampaign(this.managementApiConfig(), campaignId);
  }

  async updateCampaign(campaignId: string, input: UpdateCampaignInput): Promise<SarvamCampaign> {
    return apiUpdateCampaign(this.managementApiConfig(), campaignId, input);
  }

  /**
   * Sarvam-specific instant-outbound call creation — see initiateOutboundCall
   * above for why this is a dedicated method rather than an implementation
   * of the shared TelephonyProviderAdapter method. interaction_id is NOT
   * confirmed to be returned synchronously (module doc) — callers MUST
   * handle `result.interactionId === undefined` and rely on the webhook (or
   * the existing clientReference fallback) to learn it later, never invent
   * a placeholder.
   */
  async createInstantOutbound(input: CreateInstantOutboundInput): Promise<InstantOutboundResult> {
    return apiCreateInstantOutbound(this.managementApiConfig(), input);
  }

  /**
   * FAILS CLOSED against Sarvam's own webhook authentication/signature
   * mechanism, which is unverified in this environment (see the module doc
   * above) — SARVAM_WEBHOOK_AUTH_VERIFIED stays false and this path is
   * never satisfied by anything in the request alone.
   *
   * Phase 5 defense-in-depth (optional, off unless configured): when
   * `this.config.webhookSecret` is set, a request whose `verify_token`
   * query parameter matches it (constant-time compare) is also accepted.
   * This is NOT Sarvam proving authenticity — it is Klyro's own shared
   * secret, embedded in the exact webhook URL an operator configures into
   * the Sarvam deployment (identical in spirit to Exotel's `verify_token`
   * mechanism in exotel-provider.ts). It stops an arbitrary internet caller
   * from posting fabricated call events, but it does not cryptographically
   * prove the request came from Sarvam's servers the way a real HMAC would.
   * Until Sarvam's own mechanism is confirmed, an operator who wants any
   * webhook authentication at all for Sarvam must configure
   * SARVAM_WEBHOOK_SECRET; leaving it unset keeps this method rejecting
   * every request, exactly as before Phase 5.
   */
  verifyWebhookSignature(
    _rawBody: string,
    _headers: Record<string, string | null>,
    url?: URL,
  ): boolean {
    if (this.config.webhookSecret) {
      const provided = url?.searchParams.get("verify_token");
      if (provided && constantTimeEquals(provided, this.config.webhookSecret)) return true;
    }
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
        vaaniE164: isPlausibleE164(agentPhoneNumber) ? agentPhoneNumber : undefined,
        fromE164: isPlausibleE164(agentPhoneNumber) ? agentPhoneNumber : undefined,
        toE164: isPlausibleE164(userPhoneNumber) ? userPhoneNumber : undefined,
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
      vaaniE164: isPlausibleE164(agentPhoneNumber) ? agentPhoneNumber : undefined,
      fromE164: isPlausibleE164(userPhoneNumber) ? userPhoneNumber : undefined,
      toE164: isPlausibleE164(agentPhoneNumber) ? agentPhoneNumber : undefined,
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
