import { TelephonyAdapterError } from "./adapter.ts";

/**
 * Centralized HTTP client for Sarvam's Voice Agents *management* APIs
 * (deployments, campaigns, instant outbound) — distinct from the
 * `api-subscription-key`-authenticated chat/STT/TTS surface in
 * sarvam.server.ts and from the webhook-processing path in
 * sarvam-provider.server.ts, which never calls out to Sarvam at all.
 *
 * VERIFICATION STATUS: the four endpoint paths below (and the `X-API-Key`
 * auth header) were supplied directly in this conversation as
 * already-verified/documented API contracts — this session has never
 * independently fetched Sarvam's docs (network egress to
 * docs.sarvam.ai/apps.sarvam.ai is blocked at the proxy level) and has never
 * had a live SARVAM_API_KEY to exercise a real request. The JSON *request
 * body* field names (snake_case conversions of the verified TypeScript
 * shapes below) are this session's best-effort construction, cross-checked
 * only against the independently-verified webhook payload field names
 * (app_id, app_version, deployment_id, campaign_id, interaction_id) where
 * they overlap — anything that does NOT overlap with a verified webhook
 * field (connection_id, phone_numbers, inbound_config.*, the instant-outbound
 * destination-number field, webhook correlation fields) is UNVERIFIED
 * against a live response and flagged at its point of use below. If a real
 * request ever comes back 400, check field names here first.
 *
 * Every function here is a pure request/response boundary: it builds one
 * request, sends it, and normalizes the response or error. No tenant
 * validation, entitlement checks, or database access happen in this file —
 * that is the callers' job (sarvam-provider.server.ts's adapter methods,
 * and ultimately sarvam-admin.functions.ts / the outbound server function).
 * `fetchImpl` is always injectable so tests can exercise every branch here
 * (success, 400/401/403/429/500/503, timeout) without a real network call.
 *
 * SARVAM_API_KEY is read once by the caller and passed in as `apiKey` — it
 * is placed only in the `X-API-Key` request header, never logged, never
 * included in a thrown error message, and never echoed back in any return
 * value.
 */

export interface SarvamApiClientConfig {
  apiKey: string;
  orgId: string;
  workspaceId: string;
  /** Defaults to global fetch — injectable so tests never hit a real network. */
  fetchImpl?: typeof fetch | undefined;
  /** Defaults to 15000ms. */
  timeoutMs?: number | undefined;
}

const SARVAM_APPS_BASE_URL = "https://apps.sarvam.ai";
const DEFAULT_TIMEOUT_MS = 15_000;

function scopedPath(config: SarvamApiClientConfig, apiFamily: string, resource: string): string {
  return `/api/${apiFamily}/v1/orgs/${encodeURIComponent(config.orgId)}/workspaces/${encodeURIComponent(config.workspaceId)}/${resource}`;
}

function asPlainObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function extractSafeErrorMessage(parsed: unknown): string | undefined {
  const obj = asPlainObject(parsed);
  if (!obj) return undefined;
  for (const key of ["message", "error", "detail", "error_description"]) {
    const v = obj[key];
    if (typeof v === "string" && v) return v.slice(0, 300);
  }
  return undefined;
}

/**
 * Normalizes any non-2xx Sarvam response into a TelephonyAdapterError whose
 * status mirrors Sarvam's own, per the required 400/401/403/429/500/503
 * handling. Never includes request headers (so the API key can never leak
 * through an error message) — only a best-effort safe snippet of the
 * response body.
 */
function mapErrorResponse(status: number, parsed: unknown, rawText: string): TelephonyAdapterError {
  const safeDetail = extractSafeErrorMessage(parsed) ?? rawText.slice(0, 200);
  const suffix = safeDetail ? ` ${safeDetail}` : "";
  switch (status) {
    case 400:
      return new TelephonyAdapterError(`Sarvam rejected the request as invalid.${suffix}`, 400);
    case 401:
      return new TelephonyAdapterError("Sarvam rejected the API key as invalid or expired.", 401);
    case 403:
      return new TelephonyAdapterError("Sarvam denied access to this org/workspace/resource.", 403);
    case 429:
      return new TelephonyAdapterError(
        "Sarvam rate-limited this request. Please retry shortly.",
        429,
      );
    case 500:
    case 502:
    case 503:
    case 504:
      return new TelephonyAdapterError("Sarvam is temporarily unavailable. Please retry.", 503);
    default:
      return new TelephonyAdapterError(
        `Sarvam returned an unexpected error (${status}).${suffix}`,
        status,
      );
  }
}

async function sarvamRequest<T>(
  config: SarvamApiClientConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(`${SARVAM_APPS_BASE_URL}${path}`, {
      method,
      headers: {
        "X-API-Key": config.apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TelephonyAdapterError("Sarvam did not respond in time. Please retry.", 503);
    }
    throw new TelephonyAdapterError("Could not reach Sarvam. Please retry.", 503);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!res.ok) throw mapErrorResponse(res.status, parsed, rawText);
  return parsed as T;
}

/* ------------------------------------------------------------------ */
/* 1 & 2. Inbound deployment create / update                            */
/*    POST   /api/app-authoring/v1/orgs/{org}/workspaces/{ws}/deployments */
/*    PATCH  .../deployments/{deployment_id}                            */
/* ------------------------------------------------------------------ */

export interface DeploymentRequestShape {
  name: string;
  description?: string | undefined;
  appId: string;
  appVersion: number;
  connectionId: string;
  phoneNumbers: string[];
  inboundConfig?:
    { startTime: string; endTime: string; allowedDays: string[]; timezone: string } | undefined;
}

export interface DeploymentResult {
  deploymentId: string;
  raw: Record<string, unknown>;
}

/**
 * UNVERIFIED field names beyond app_id/app_version (see module doc):
 * connection_id, phone_numbers, inbound_config.{start_time,end_time,
 * allowed_days,timezone}.
 */
function toDeploymentRequestBody(input: DeploymentRequestShape): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name,
    app_id: input.appId,
    app_version: input.appVersion,
    connection_id: input.connectionId,
    phone_numbers: input.phoneNumbers,
  };
  if (input.description !== undefined) body["description"] = input.description;
  if (input.inboundConfig) {
    body["inbound_config"] = {
      start_time: input.inboundConfig.startTime,
      end_time: input.inboundConfig.endTime,
      allowed_days: input.inboundConfig.allowedDays,
      timezone: input.inboundConfig.timezone,
    };
  }
  return body;
}

function parseDeploymentResponse(parsed: unknown): DeploymentResult {
  const obj = asPlainObject(parsed);
  const deploymentId = obj?.["deployment_id"];
  if (typeof deploymentId !== "string" || !deploymentId) {
    throw new TelephonyAdapterError(
      "Sarvam accepted the deployment request but the response did not include a deployment_id.",
      502,
    );
  }
  return { deploymentId, raw: obj ?? {} };
}

export async function createDeployment(
  config: SarvamApiClientConfig,
  input: DeploymentRequestShape,
): Promise<DeploymentResult> {
  const parsed = await sarvamRequest<unknown>(
    config,
    "POST",
    scopedPath(config, "app-authoring", "deployments"),
    toDeploymentRequestBody(input),
  );
  return parseDeploymentResponse(parsed);
}

export interface UpdateDeploymentInput {
  name?: string | undefined;
  description?: string | undefined;
  phoneNumbers?: string[] | undefined;
  inboundConfig?:
    { startTime: string; endTime: string; allowedDays: string[]; timezone: string } | undefined;
}

export async function updateDeployment(
  config: SarvamApiClientConfig,
  deploymentId: string,
  input: UpdateDeploymentInput,
): Promise<DeploymentResult> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body["name"] = input.name;
  if (input.description !== undefined) body["description"] = input.description;
  if (input.phoneNumbers !== undefined) body["phone_numbers"] = input.phoneNumbers;
  if (input.inboundConfig) {
    body["inbound_config"] = {
      start_time: input.inboundConfig.startTime,
      end_time: input.inboundConfig.endTime,
      allowed_days: input.inboundConfig.allowedDays,
      timezone: input.inboundConfig.timezone,
    };
  }
  const parsed = await sarvamRequest<unknown>(
    config,
    "PATCH",
    scopedPath(config, "app-authoring", `deployments/${encodeURIComponent(deploymentId)}`),
    body,
  );
  return parseDeploymentResponse(parsed);
}

/* ------------------------------------------------------------------ */
/* 3. Campaigns                                                         */
/*    GET   /api/scheduling/v1/orgs/{org}/workspaces/{ws}/campaigns     */
/*    GET   .../campaigns/{campaign_id}                                 */
/*    PATCH .../campaigns/{campaign_id}                                 */
/*    (the /campaigns list path itself is the one endpoint this session */
/*    was given verbatim as a read-only test target — see the migration */
/*    report; everything else on this path family follows the same     */
/*    org/workspace-scoping convention, not independently confirmed.)   */
/* ------------------------------------------------------------------ */

export interface SarvamCampaign {
  campaignId: string;
  raw: Record<string, unknown>;
}

function parseCampaign(parsed: unknown): SarvamCampaign {
  const obj = asPlainObject(parsed);
  const campaignId = obj?.["campaign_id"];
  if (typeof campaignId !== "string" || !campaignId) {
    throw new TelephonyAdapterError(
      "Sarvam returned a campaign response without a campaign_id.",
      502,
    );
  }
  return { campaignId, raw: obj ?? {} };
}

export interface ListCampaignsResult {
  campaigns: SarvamCampaign[];
  raw: unknown;
}

export async function listCampaigns(config: SarvamApiClientConfig): Promise<ListCampaignsResult> {
  const parsed = await sarvamRequest<unknown>(
    config,
    "GET",
    scopedPath(config, "scheduling", "campaigns"),
  );
  const obj = asPlainObject(parsed);
  const items = obj?.["campaigns"];
  const list: unknown[] = Array.isArray(items)
    ? items
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];
  return { campaigns: list.map(parseCampaign), raw: parsed };
}

export async function getCampaign(
  config: SarvamApiClientConfig,
  campaignId: string,
): Promise<SarvamCampaign> {
  const parsed = await sarvamRequest<unknown>(
    config,
    "GET",
    scopedPath(config, "scheduling", `campaigns/${encodeURIComponent(campaignId)}`),
  );
  return parseCampaign(parsed);
}

export interface UpdateCampaignInput {
  name?: string | undefined;
  /** Exact accepted string values unverified — passed through as given. */
  status?: string | undefined;
  webhookConfig?:
    { url?: string | undefined; metadata?: Record<string, unknown> | undefined } | undefined;
}

export async function updateCampaign(
  config: SarvamApiClientConfig,
  campaignId: string,
  input: UpdateCampaignInput,
): Promise<SarvamCampaign> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body["name"] = input.name;
  if (input.status !== undefined) body["status"] = input.status;
  if (input.webhookConfig) {
    const webhookConfig: Record<string, unknown> = {};
    if (input.webhookConfig.url !== undefined) webhookConfig["url"] = input.webhookConfig.url;
    if (input.webhookConfig.metadata !== undefined)
      webhookConfig["metadata"] = input.webhookConfig.metadata;
    body["webhook_config"] = webhookConfig;
  }
  const parsed = await sarvamRequest<unknown>(
    config,
    "PATCH",
    scopedPath(config, "scheduling", `campaigns/${encodeURIComponent(campaignId)}`),
    body,
  );
  return parseCampaign(parsed);
}

/* ------------------------------------------------------------------ */
/* 4. Instant outbound                                                  */
/*    POST /api/outbounds/v1/orgs/{org}/workspaces/{ws}/outbounds       */
/* ------------------------------------------------------------------ */

/**
 * Request shape supplied directly by the user as an already-confirmed Sarvam
 * example (not this session's own reconstruction) — treated as
 * higher-confidence ground truth than the earlier flat body this replaces,
 * though still not independently live-tested (no SARVAM_API_KEY available
 * in this environment). Structurally: `app_config` (which agent/version/
 * connection to use + per-call variables/overrides), `user_config` (who to
 * call), `webhook_config` (where Sarvam should report the result, plus a
 * `metadata` object Sarvam is expected to echo back verbatim on that
 * webhook — see sarvam-provider.server.ts's extractClientReference/
 * extractMetadataOrganizationId, which now read this object first).
 */
export interface CreateInstantOutboundInput {
  appId: string;
  appVersion: number;
  connectionId: string;
  /** The assigned Klyro number's own E.164 — the caller ID the contact sees. */
  fromE164: string;
  toE164: string;
  agentVariables?: Record<string, unknown> | undefined;
  /** Optional per-call overrides — both fields are optional passthroughs; omit either to use the agent's own configured default. */
  appOverrides?:
    { initialBotMessage?: string | undefined; initialStateName?: string | undefined } | undefined;
  /** Klyro's own public webhook URL for this call to land on — never a bare host, always the full route + ?provider=sarvam. */
  webhookUrl: string;
  /**
   * Correlation metadata Klyro expects Sarvam to echo back verbatim on the
   * resulting webhook. `organizationId` is REQUIRED here (used only as a
   * defense-in-depth cross-check on the way back in, never as the sole
   * resolver — see extractMetadataOrganizationId's doc). The others are
   * whichever of Klyro's own already-existing identifiers apply to this
   * call; omit whichever don't (e.g. a non-campaign instant-outbound call
   * has no campaignId/campaignContactId).
   */
  metadata: {
    organizationId: string;
    leadId?: string | undefined;
    campaignId?: string | undefined;
    campaignContactId?: string | undefined;
    /**
     * NOT part of the user-supplied example's four named fields — added
     * because metadata is a generic passthrough object (webhook payloads
     * echo back whatever was sent, not a fixed key whitelist) and the
     * single, non-campaign instant-outbound call path
     * (sarvam-outbound.functions.ts) has no lead/campaign id to correlate
     * with, only its own call_logs.id. Extends the given shape additively;
     * never replaces any of its four named fields.
     */
    callId?: string | undefined;
  };
}

export interface InstantOutboundResult {
  /**
   * May be absent: Sarvam's instant-outbound response is not confirmed to
   * return interaction_id synchronously. Callers MUST handle `undefined`
   * here — the webhook's own interaction_id (or the clientReference fallback
   * via resolveOutboundCallByClientReference) is the durable source of truth,
   * not this return value.
   */
  interactionId: string | undefined;
  raw: Record<string, unknown>;
}

function toInstantOutboundBody(input: CreateInstantOutboundInput): Record<string, unknown> {
  const appConfig: Record<string, unknown> = {
    app_id: input.appId,
    app_version: input.appVersion,
    app_type: "agent",
    connection_config: {
      connection_id: input.connectionId,
      agent_phone_number: input.fromE164,
    },
  };
  if (input.agentVariables !== undefined) appConfig["agent_variables"] = input.agentVariables;
  if (input.appOverrides) {
    const overrides: Record<string, unknown> = {};
    if (input.appOverrides.initialBotMessage !== undefined)
      overrides["initial_bot_message"] = input.appOverrides.initialBotMessage;
    if (input.appOverrides.initialStateName !== undefined)
      overrides["initial_state_name"] = input.appOverrides.initialStateName;
    if (Object.keys(overrides).length > 0) appConfig["app_overrides"] = overrides;
  }

  const metadata: Record<string, string> = { organization_id: input.metadata.organizationId };
  if (input.metadata.leadId !== undefined) metadata["lead_id"] = input.metadata.leadId;
  if (input.metadata.campaignId !== undefined) metadata["campaign_id"] = input.metadata.campaignId;
  if (input.metadata.campaignContactId !== undefined)
    metadata["campaign_contact_id"] = input.metadata.campaignContactId;
  if (input.metadata.callId !== undefined) metadata["call_id"] = input.metadata.callId;

  return {
    app_config: appConfig,
    user_config: { user_phone_number: input.toE164 },
    webhook_config: { url: input.webhookUrl, metadata },
  };
}

export async function createInstantOutbound(
  config: SarvamApiClientConfig,
  input: CreateInstantOutboundInput,
): Promise<InstantOutboundResult> {
  const parsed = await sarvamRequest<unknown>(
    config,
    "POST",
    scopedPath(config, "outbounds", "outbounds"),
    toInstantOutboundBody(input),
  );
  const obj = asPlainObject(parsed) ?? {};
  const interactionId = obj["interaction_id"];
  return {
    interactionId: typeof interactionId === "string" && interactionId ? interactionId : undefined,
    raw: obj,
  };
}

/* ------------------------------------------------------------------ */
/* 5. Cohort upload (bulk campaign dispatch)                            */
/*    POST /api/scheduling/v1/orgs/{org}/workspaces/{ws}/campaigns/     */
/*         {campaign_id}/cohorts/upload                                 */
/*                                                                       */
/* VERIFICATION STATUS — MEDIUM CONFIDENCE, NOT INDEPENDENTLY CONFIRMED: */
/* this schema comes from WebSearch-synthesized snippets of a site that */
/* self-titles "Welcome to Sarvam Agents - Agent Docs" at                */
/* agent-docs.azurewebsites.net — a site distinct from docs.sarvam.ai,  */
/* never directly fetched in this environment (also EGRESS_BLOCKED), so */
/* its authenticity/ownership could not be confirmed the way            */
/* docs.sarvam.ai pages at least partially were. The schema below was   */
/* corroborated across multiple independent search queries with         */
/* consistent field names, which is more evidence than the deployment/  */
/* campaign-PATCH endpoints above ever had — but it is still NOT a      */
/* primary-source fetch and NOT a live-tested response. Do not treat    */
/* this as "verified" the way createInstantOutbound's endpoint path is  */
/* (that one is at least corroborated by the org/workspace scoping      */
/* convention shared with the independently-fetched conv-ai-sdk). This  */
/* function must not be enabled in production (see                     */
/* campaigns.functions.ts's KLYRO_DISPATCH_MODE gate) until it has been */
/* exercised against a real response.                                   */
/* ------------------------------------------------------------------ */

export interface CohortTransformation {
  /** CSV column name holding the destination phone number. */
  phoneNumberColumn: string;
  /** CSV column name holding a value Sarvam should echo back on every webhook for this row (Klyro sets this to its own campaign_contacts.id). */
  userIdentifierColumn: string;
  /** {agentVariableName: csvColumnName} — keys must match the target agent's own declared variables (per the source page); unknown keys are presumed rejected per-row, not per-request. */
  appVariableColumns: Record<string, string>;
}

export interface UploadCohortInput {
  campaignId: string;
  cohortName: string;
  /** Full CSV text, header row + data rows, matching the column names referenced in `transformation`. */
  csvText: string;
  transformation: CohortTransformation;
}

export interface UploadCohortResult {
  cohortId: string;
  totalRecords: number;
  validRecords: number;
  rejectedRecords: number;
  raw: Record<string, unknown>;
}

function buildTransformationJson(t: CohortTransformation): string {
  return JSON.stringify({
    phone_number: t.phoneNumberColumn,
    user_identifier: t.userIdentifierColumn,
    app_variables: t.appVariableColumns,
  });
}

/**
 * Multipart upload — deliberately does NOT go through sarvamRequest (which
 * always sets Content-Type: application/json): the browser/runtime's
 * FormData + fetch sets the correct multipart boundary itself, and manually
 * setting Content-Type here would break it.
 */
export async function uploadCohort(
  config: SarvamApiClientConfig,
  input: UploadCohortInput,
): Promise<UploadCohortResult> {
  const form = new FormData();
  form.append("name", input.cohortName);
  form.append("cohort_file", new Blob([input.csvText], { type: "text/csv" }), "contacts.csv");
  form.append(
    "cohort_transformation_file",
    new Blob([buildTransformationJson(input.transformation)], { type: "application/json" }),
    "transformation.json",
  );

  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(
      `${SARVAM_APPS_BASE_URL}${scopedPath(config, "scheduling", `campaigns/${encodeURIComponent(input.campaignId)}/cohorts/upload`)}`,
      {
        method: "POST",
        headers: { "X-API-Key": config.apiKey },
        body: form,
        signal: controller.signal,
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TelephonyAdapterError("Sarvam did not respond in time. Please retry.", 503);
    }
    throw new TelephonyAdapterError("Could not reach Sarvam. Please retry.", 503);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) throw mapErrorResponse(res.status, parsed, rawText);

  const obj = asPlainObject(parsed) ?? {};
  const result = asPlainObject(obj["result"]) ?? obj;
  const cohortId = obj["cohort_id"];
  if (typeof cohortId !== "string" || !cohortId) {
    throw new TelephonyAdapterError(
      "Sarvam accepted the cohort upload but the response did not include a cohort_id.",
      502,
    );
  }
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    cohortId,
    totalRecords: num(result["total_records"]),
    validRecords: num(result["valid_records"]),
    rejectedRecords: num(result["rejected_records"]),
    raw: obj,
  };
}
