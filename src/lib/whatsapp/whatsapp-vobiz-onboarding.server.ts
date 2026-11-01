/**
 * Connecting a WhatsApp number through Vobiz — the three onboarding modes
 * Vobiz supports, each ending in a Vobiz channel that ClickAI records as a
 * whatsapp_connections row (provider 'vobiz'):
 *
 *   1. Bring your own number (BYON, 'bring_your_own'): Vobiz texts or calls
 *      an OTP to the number, the business confirms it, then the channel is
 *      created with the business's own Meta WABA id, phone number id and
 *      Meta system-user token. The token is passed straight to Vobiz (which
 *      stores it write-only) and never stored or logged by ClickAI.
 *   2. A ClickAI number ('buy_from_vobiz'): only a platform admin buys one,
 *      through ClickAI's Vobiz account, for one organization
 *      (purchaseNumberForOrganization — a purchase-lock row is written
 *      first, so a repeat can never buy twice). The purchase lands in the
 *      phone-number inventory (phone_numbers, WhatsApp-capable) and, once an
 *      admin has activated it, the organization's owner/admin connects it to
 *      their WhatsApp Business Account (connectAssignedNumber). Customers
 *      can't buy numbers.
 *   3. Embedded Signup through Vobiz ('embedded_signup'): the browser runs
 *      Meta's Embedded Signup popup with the Meta app Vobiz exchanges codes
 *      for, and the resulting OAuth code + WABA id are handed to Vobiz.
 *
 * Callers own authentication and authorization: the customer functions take
 * a scope already resolved by requireWhatsAppManager (owner/admin of the
 * target business's organization), the purchase functions are called only
 * after assertPlatformAdmin. All writes use the service role and filter by
 * the scope's organization explicitly.
 *
 * Partial failures: a channel Vobiz created during a request whose response
 * was lost (timeout, network, conflict) is found again with
 * `GET /channels/whatsapp` and adopted, so a retry never needs a second
 * channel — unless that channel belongs to another WhatsApp Business
 * Account or another organization. A number live for another organization,
 * or held in ClickAI's inventory by another organization (or unassigned),
 * is refused before Vobiz is asked to do anything; the database enforces
 * the same (20261028090000).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { WhatsAppManagerScope } from "./whatsapp-access.server.ts";
import {
  VobizApiError,
  type NumberOnboardingMode,
  type VobizChannel,
  type VobizWhatsAppClient,
} from "./vobiz-whatsapp-client.server.ts";

type Client = SupabaseClient<Database>;
type Vobiz = Pick<
  VobizWhatsAppClient,
  | "startByonVerification"
  | "confirmByonVerification"
  | "createChannel"
  | "completeEmbeddedSignup"
  | "listChannels"
  | "searchAvailableNumbers"
  | "createNumberOrder"
>;

export class WhatsAppOnboardingError extends Error {
  code:
    | "invalid_input"
    | "duplicate_phone_number"
    | "provider_rejected"
    | "provider_unavailable"
    | "rate_limited"
    | "order_not_ready"
    | "not_found"
    | "incomplete_channel"
    | "verification_expired"
    | "recovery_refused";
  constructor(message: string, code: WhatsAppOnboardingError["code"]) {
    super(message);
    this.code = code;
  }
}

export interface ConnectedWhatsAppNumber {
  connectionId: string;
  status: "connected";
  phoneNumber: string | null;
  numberOnboardingMode: NumberOnboardingMode;
  /** True when the number was already connected to this organization (repeat request). */
  alreadyConnected: boolean;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const META_ID = /^\d{5,25}$/;
/** OTP requests (SMS/voice cost money and reach a real phone) per organization per hour. */
export const BYON_OTP_REQUESTS_PER_HOUR = 5;

function requireE164(value: string): string {
  const v = value.replace(/[\s()-]/g, "");
  const withPlus = v.startsWith("+") ? v : `+${v}`;
  if (!E164.test(withPlus)) {
    throw new WhatsAppOnboardingError(
      "Enter the phone number in international format, e.g. +919876543210.",
      "invalid_input",
    );
  }
  return withPlus;
}

function requireMetaId(value: string, label: string): string {
  const v = value.trim();
  if (!META_ID.test(v)) {
    throw new WhatsAppOnboardingError(
      `${label} should be the numeric id from Meta.`,
      "invalid_input",
    );
  }
  return v;
}

/** Turns a Vobiz client error into a customer-safe onboarding error. */
function fromVobiz(err: unknown): WhatsAppOnboardingError {
  if (err instanceof WhatsAppOnboardingError) return err;
  if (err instanceof VobizApiError) {
    return err.isRejection
      ? new WhatsAppOnboardingError(err.message, "provider_rejected")
      : new WhatsAppOnboardingError(
          err.kind === "http"
            ? err.message
            : "Couldn't get a response from Vobiz. Please try again in a moment.",
          "provider_unavailable",
        );
  }
  return new WhatsAppOnboardingError(
    "Something went wrong talking to Vobiz.",
    "provider_unavailable",
  );
}

/** A live (not disconnected) connection for this Meta phone number id, in any organization. */
async function findLiveByPhoneNumberId(admin: Client, phoneNumberId: string) {
  const { data, error } = await admin
    .from("whatsapp_connections")
    .select(
      "id, organization_id, provider, vobiz_channel_id, display_phone_number, number_onboarding_mode",
    )
    .eq("phone_number_id", phoneNumberId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Refuses a number live for another organization; returns this organization's live Vobiz row, if any. */
async function guardPhoneNumber(admin: Client, scope: WhatsAppManagerScope, phoneNumberId: string) {
  const existing = await findLiveByPhoneNumberId(admin, phoneNumberId);
  if (existing && existing.organization_id !== scope.organizationId) {
    throw new WhatsAppOnboardingError(
      "This WhatsApp number is already connected to a different ClickAI account.",
      "duplicate_phone_number",
    );
  }
  return existing;
}

/** Ways the same E.164 number may be stored. */
function numberForms(e164: string): string[] {
  return [e164, e164.replace(/^\+/, "")];
}

/** Refuses a number ClickAI holds in its inventory for another organization (or unassigned). */
async function guardInventoryNumber(admin: Client, scope: WhatsAppManagerScope, e164: string) {
  const { data, error } = await admin
    .from("phone_numbers")
    .select("id, organization_id")
    .in("e164", numberForms(e164))
    .not("status", "in", "(released,failed)");
  if (error) throw error;
  if ((data ?? []).some((n) => n.organization_id !== scope.organizationId)) {
    throw new WhatsAppOnboardingError(
      "This number belongs to another ClickAI account.",
      "duplicate_phone_number",
    );
  }
}

/** The ownership triggers' refusals (20261028090000), as onboarding errors. */
function ownershipError(error: {
  code?: string;
  message?: string;
}): WhatsAppOnboardingError | null {
  if (error.code !== "P0001") return null;
  if (/whatsapp_number_owned_elsewhere/.test(error.message ?? "")) {
    return new WhatsAppOnboardingError(
      "This number belongs to another ClickAI account.",
      "duplicate_phone_number",
    );
  }
  if (/whatsapp_number_not_assigned/.test(error.message ?? "")) {
    return new WhatsAppOnboardingError(
      "This number isn't an active ClickAI number of this workspace.",
      "not_found",
    );
  }
  return null;
}

/**
 * What a recovered channel must match. Recovery searches every channel on
 * ClickAI's (single) Vobiz account, so a number match alone is never
 * enough: the channel must be on the expected WhatsApp Business Account and
 * carry the expected Meta phone number id (BYON, Embedded Signup) or Vobiz
 * number order (a ClickAI number, whose phone number id Meta assigns later).
 */
interface RecoveryMatch {
  wabaId: string;
  phoneNumberId?: string | null;
  numberOrderId?: string | null;
  phoneNumber?: string | null;
}

const RECOVERY_REFUSED =
  "Vobiz already has a WhatsApp channel for this number that ClickAI can't safely link to this account. Contact ClickAI support to resolve it.";

/** Exported for tests: is this listed channel the one this request created? */
export function recoveryVerdict(
  c: VobizChannel,
  match: RecoveryMatch,
): "adopt" | "conflict" | "unrelated" {
  const samePhoneNumberId = Boolean(match.phoneNumberId && c.phoneNumberId === match.phoneNumberId);
  const sameOrder = Boolean(match.numberOrderId && c.numberOrderId === match.numberOrderId);
  const sameNumber = Boolean(match.phoneNumber && c.phoneNumber === match.phoneNumber);
  if (!samePhoneNumberId && !sameOrder && !sameNumber) return "unrelated";
  // Every identifier the request knows must be present on the channel and equal.
  if (!c.wabaId || c.wabaId !== match.wabaId) return "conflict";
  if (match.phoneNumberId && c.phoneNumberId !== match.phoneNumberId) return "conflict";
  if (match.numberOrderId && c.numberOrderId !== match.numberOrderId) return "conflict";
  if (!match.phoneNumberId && !match.numberOrderId) return "conflict";
  if (match.phoneNumber && c.phoneNumber && c.phoneNumber !== match.phoneNumber) return "conflict";
  return "adopt";
}

/**
 * After a lost/conflicting response: the channel Vobiz may already have
 * created for this request. Null when there's nothing to adopt; refuses
 * (for an administrator to resolve) when a channel for the number exists
 * but doesn't match every expected identifier, or more than one matches.
 * Ownership in ClickAI (a channel another organization has used) is checked
 * again in persistChannel.
 */
async function recoverChannel(vobiz: Vobiz, match: RecoveryMatch): Promise<VobizChannel | null> {
  let channels: VobizChannel[];
  try {
    channels = await vobiz.listChannels();
  } catch {
    return null;
  }
  const adoptable: VobizChannel[] = [];
  let conflicts = 0;
  for (const c of channels) {
    const verdict = recoveryVerdict(c, match);
    if (verdict === "adopt") adoptable.push(c);
    else if (verdict === "conflict") conflicts++;
  }
  if (adoptable.length === 1) return adoptable[0]!;
  if (adoptable.length > 1 || conflicts > 0) {
    console.error("whatsapp_onboarding:recovery_refused", {
      adoptable: adoptable.length,
      conflicts,
    });
    throw new WhatsAppOnboardingError(RECOVERY_REFUSED, "recovery_refused");
  }
  return null;
}

/** Creates the channel, adopting one Vobiz already made if the response was lost or conflicted. */
async function createOrRecover(
  vobiz: Vobiz,
  create: () => Promise<VobizChannel>,
  match: RecoveryMatch,
): Promise<VobizChannel> {
  try {
    return await create();
  } catch (err) {
    // Vobiz may have created it (no response, 5xx, unusable 2xx) or says it
    // exists (409): look for it — the strict match in recoverChannel decides.
    const recoverable = err instanceof VobizApiError && (err.isAmbiguous || err.status === 409);
    if (recoverable) {
      const existing = await recoverChannel(vobiz, match);
      if (existing) return existing;
    }
    throw fromVobiz(err);
  }
}

/** Records the Vobiz channel as this organization's live connection (insert, or update the same number's row). */
async function persistChannel(
  admin: Client,
  scope: WhatsAppManagerScope,
  channel: VobizChannel,
  input: {
    mode: NumberOnboardingMode;
    phoneNumberId: string | null;
    phoneNumber: string | null;
    wabaId: string;
    displayName?: string | null | undefined;
    numberOrderId?: string | null | undefined;
    /** The ClickAI inventory number this channel was made from. */
    inventoryNumberId?: string | null | undefined;
  },
): Promise<string> {
  const phoneNumberId = channel.phoneNumberId ?? input.phoneNumberId;
  if (!phoneNumberId) {
    throw new WhatsAppOnboardingError(
      `Vobiz created the channel (${channel.id}) but didn't return its WhatsApp phone number id, so ClickAI can't route its messages yet. Contact support with this channel id.`,
      "incomplete_channel",
    );
  }
  // Whatever Vobiz returned (created or recovered) must be the channel this
  // request asked for: never another WhatsApp Business Account's channel or
  // another phone number id's (it would carry someone else's Meta credentials).
  if (
    (channel.wabaId && channel.wabaId !== input.wabaId) ||
    (channel.phoneNumberId && input.phoneNumberId && channel.phoneNumberId !== input.phoneNumberId)
  ) {
    console.error("whatsapp_onboarding:channel_identity_mismatch", {
      channelId: channel.id,
      mode: input.mode,
    });
    throw new WhatsAppOnboardingError(RECOVERY_REFUSED, "recovery_refused");
  }
  // A channel another organization has used (even one it has disconnected)
  // is never handed to this one: it carries that organization's WhatsApp
  // Business Account and history.
  const { data: foreign, error: foreignError } = await admin
    .from("whatsapp_connections")
    .select("id")
    .eq("vobiz_channel_id", channel.id)
    .neq("organization_id", scope.organizationId)
    .limit(1);
  if (foreignError) throw foreignError;
  if ((foreign ?? []).length > 0) {
    console.error("whatsapp_onboarding:channel_owned_elsewhere", { channelId: channel.id });
    throw new WhatsAppOnboardingError(RECOVERY_REFUSED, "recovery_refused");
  }
  const now = new Date().toISOString();
  const row = {
    organization_id: scope.organizationId,
    business_id: scope.businessId,
    waba_id: channel.wabaId ?? input.wabaId,
    phone_number_id: phoneNumberId,
    display_phone_number: channel.phoneNumber ?? input.phoneNumber,
    verified_name: channel.displayName ?? input.displayName ?? null,
    status: "connected",
    provider: "vobiz",
    vobiz_channel_id: channel.id,
    number_onboarding_mode: input.mode,
    vobiz_number_order_id: channel.numberOrderId ?? input.numberOrderId ?? null,
    inventory_number_id: input.inventoryNumberId ?? null,
    // Vobiz holds the Meta credentials; nothing for ClickAI to keep.
    access_token_ciphertext: null,
    two_step_pin_ciphertext: null,
    // Webhooks come from ClickAI's account-level Vobiz subscription.
    webhook_subscribed: true,
    last_error: null,
    last_connected_at: now,
    disconnected_at: null,
  };

  const existing = await guardPhoneNumber(admin, scope, phoneNumberId);
  if (existing) {
    const { error } = await admin
      .from("whatsapp_connections")
      .update(row)
      .eq("id", existing.id)
      .eq("organization_id", scope.organizationId);
    if (error) throw ownershipError(error) ?? error;
    return existing.id;
  }
  const { data, error } = await admin
    .from("whatsapp_connections")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      // A concurrent request of this same organization may have just recorded
      // this very channel: that is the same connection, not a conflict.
      const { data: winner, error: winnerError } = await admin
        .from("whatsapp_connections")
        .select("id, organization_id, vobiz_channel_id")
        .eq("vobiz_channel_id", channel.id)
        .neq("status", "disconnected")
        .maybeSingle();
      if (winnerError) throw winnerError;
      if (winner && winner.organization_id === scope.organizationId) return winner.id;
      throw new WhatsAppOnboardingError(
        "This WhatsApp number is already connected to a different ClickAI account.",
        "duplicate_phone_number",
      );
    }
    throw ownershipError(error) ?? error;
  }
  return data.id;
}

// ---------------------------------------------------------------------------
// 1. Bring your own number

/**
 * The result of asking Vobiz to send a BYON code. Neither state means a code
 * was delivered — Vobiz documents no delivery confirmation for these codes —
 * and the number is not verified or connected until connectByon succeeds.
 *   - `verification_requested`: Vobiz accepted the request (2xx, status
 *     "pending", with its verification id and, if given, the expiry).
 *   - `verification_unconfirmed`: Vobiz answered 2xx, but not with a
 *     response ClickAI recognizes; a code may or may not have been sent.
 */
export type ByonVerificationResult =
  | {
      phoneNumber: string;
      state: "verification_requested";
      deliveryConfirmed: false;
      providerReference: string;
      providerStatus: "pending";
      expiresAt: string | null;
    }
  | {
      phoneNumber: string;
      state: "verification_unconfirmed";
      deliveryConfirmed: false;
      providerReference: string | null;
      providerStatus: string | null;
      expiresAt: null;
    };

/** Kept for callers that named the earlier single-state type. */
export type ByonVerificationRequested = ByonVerificationResult;

const BYON_RATE_WINDOW_SECONDS = 60 * 60;

async function setVerificationState(
  admin: Client,
  verificationRowId: string,
  patch: Database["public"]["Tables"]["whatsapp_byon_verifications"]["Update"],
): Promise<void> {
  const { error } = await admin
    .from("whatsapp_byon_verifications")
    .update(patch)
    .eq("id", verificationRowId);
  if (error) throw error;
}

export async function startByonVerification(
  admin: Client,
  scope: WhatsAppManagerScope,
  input: { phoneNumber: string; method: "sms" | "voice" },
  deps: { vobiz: Vobiz },
): Promise<ByonVerificationResult> {
  const phoneNumber = requireE164(input.phoneNumber);
  // Never text/call a verification code to a number ClickAI holds for someone else.
  await guardInventoryNumber(admin, scope, phoneNumber);

  // The hourly limit, atomically: the claim and its row are one serialized
  // step per organization (20261029090000), so concurrent requests can't
  // all pass the same count. Every claim counts unless Vobiz refused it.
  const { data: verificationRowId, error: claimError } = await admin.rpc(
    "claim_whatsapp_byon_verification",
    {
      _organization_id: scope.organizationId,
      _phone_number: phoneNumber,
      _method: input.method,
      _limit: BYON_OTP_REQUESTS_PER_HOUR,
      _window_seconds: BYON_RATE_WINDOW_SECONDS,
    },
  );
  if (claimError) throw claimError;
  if (!verificationRowId) {
    throw new WhatsAppOnboardingError(
      "Too many verification codes requested. Please wait an hour and try again.",
      "rate_limited",
    );
  }

  let answer: Awaited<ReturnType<Vobiz["startByonVerification"]>>;
  try {
    answer = await deps.vobiz.startByonVerification({ phoneNumber, method: input.method });
  } catch (err) {
    if (err instanceof VobizApiError && err.isRejection) {
      // Vobiz refused (4xx): no code was sent, so this attempt doesn't count.
      await setVerificationState(admin, verificationRowId, { state: "rejected" });
      throw fromVobiz(err);
    }
    // Timeout, network failure, 429 or 5xx: Vobiz may still have sent a code.
    await setVerificationState(admin, verificationRowId, { state: "unavailable" });
    console.warn("whatsapp_byon:verify_outcome_unknown", {
      kind: err instanceof VobizApiError ? err.kind : "unknown",
      status: err instanceof VobizApiError ? err.status : null,
    });
    throw new WhatsAppOnboardingError(
      "Vobiz didn't confirm the verification request, so ClickAI can't tell whether a code was sent. If a code arrives in the next few minutes you can still enter it; otherwise wait a few minutes before requesting another.",
      "provider_unavailable",
    );
  }

  if (answer.kind === "unrecognized") {
    // Never treated as success or as failure: logged with validated fields only.
    console.warn("whatsapp_byon:verify_response_unrecognized", {
      reason: answer.reason,
      status: answer.status,
      keys: answer.keys,
    });
  }
  await setVerificationState(
    admin,
    verificationRowId,
    answer.kind === "pending"
      ? {
          state: "pending",
          provider_verification_id: answer.verificationId,
          provider_status: answer.status,
          expires_at: answer.expiresAt,
        }
      : {
          state: "unrecognized",
          provider_verification_id: answer.verificationId,
          provider_status: answer.status,
        },
  );
  // The organization's timeline. Only what Vobiz said — never the code, the
  // token or credentials — and never a claim that the code was delivered.
  const { error: logError } = await admin.from("customer_events").insert({
    organization_id: scope.organizationId,
    kind: "whatsapp_byon_otp_requested",
    title:
      answer.kind === "pending"
        ? "WhatsApp verification requested (accepted by Vobiz; delivery not confirmed)"
        : "WhatsApp verification requested (Vobiz's answer not recognized; outcome unknown)",
    detail: `${phoneNumber} via ${input.method}`,
    metadata: {
      method: input.method,
      state: answer.kind === "pending" ? "verification_requested" : "verification_unconfirmed",
      provider_status: answer.status,
      provider_reference: answer.verificationId,
      provider_response_recognized: answer.kind === "pending",
      expires_at: answer.kind === "pending" ? answer.expiresAt : null,
      verification_id: verificationRowId,
    },
  });
  if (logError) throw logError;

  return answer.kind === "pending"
    ? {
        phoneNumber,
        state: "verification_requested",
        deliveryConfirmed: false,
        providerReference: answer.verificationId,
        providerStatus: "pending",
        expiresAt: answer.expiresAt,
      }
    : {
        phoneNumber,
        state: "verification_unconfirmed",
        deliveryConfirmed: false,
        providerReference: answer.verificationId,
        providerStatus: answer.status,
        expiresAt: null,
      };
}

/** The latest code request for this number by this organization, if any. */
async function latestVerification(admin: Client, organizationId: string, phoneNumber: string) {
  const { data, error } = await admin
    .from("whatsapp_byon_verifications")
    .select("id, state, expires_at")
    .eq("organization_id", organizationId)
    .eq("phone_number", phoneNumber)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function connectByon(
  admin: Client,
  scope: WhatsAppManagerScope,
  input: {
    phoneNumber: string;
    otpCode: string;
    wabaId: string;
    phoneNumberId: string;
    accessToken: string;
    displayName?: string | null | undefined;
  },
  deps: { vobiz: Vobiz; now?: () => Date },
): Promise<ConnectedWhatsAppNumber> {
  const phoneNumber = requireE164(input.phoneNumber);
  const wabaId = requireMetaId(input.wabaId, "WhatsApp Business Account ID");
  const phoneNumberId = requireMetaId(input.phoneNumberId, "Phone number ID");
  const otpCode = input.otpCode.trim();
  if (!/^\d{4,8}$/.test(otpCode)) {
    throw new WhatsAppOnboardingError("Enter the verification code you received.", "invalid_input");
  }
  const accessToken = input.accessToken.trim();
  if (!/^EAA[A-Za-z0-9]{20,}$/.test(accessToken)) {
    throw new WhatsAppOnboardingError(
      "Paste the Meta system-user access token (it starts with EAA).",
      "invalid_input",
    );
  }

  await guardInventoryNumber(admin, scope, phoneNumber);
  const existing = await guardPhoneNumber(admin, scope, phoneNumberId);
  if (existing && existing.provider === "vobiz" && existing.vobiz_channel_id) {
    return {
      connectionId: existing.id,
      status: "connected",
      phoneNumber: existing.display_phone_number,
      numberOnboardingMode: "bring_your_own",
      alreadyConnected: true,
    };
  }

  // Vobiz told us when the latest code expires: don't send a code we know
  // is stale. (No recorded request — e.g. one made before this was tracked —
  // leaves the check to Vobiz.)
  const latest = await latestVerification(admin, scope.organizationId, phoneNumber);
  const now = (deps.now ?? (() => new Date()))();
  if (
    latest?.state === "pending" &&
    latest.expires_at &&
    new Date(latest.expires_at).getTime() <= now.getTime()
  ) {
    throw new WhatsAppOnboardingError(
      "This verification code has expired. Request a new code.",
      "verification_expired",
    );
  }
  try {
    await deps.vobiz.confirmByonVerification({ phoneNumber, otpCode });
  } catch (err) {
    throw fromVobiz(err);
  }
  if (latest) await setVerificationState(admin, latest.id, { state: "confirmed" });
  const channel = await createOrRecover(
    deps.vobiz,
    () =>
      deps.vobiz.createChannel({
        mode: "bring_your_own",
        wabaId,
        phoneNumberId,
        phoneNumber,
        accessToken,
        displayName: input.displayName ?? undefined,
      }),
    { phoneNumberId, phoneNumber, wabaId },
  );
  const connectionId = await persistChannel(admin, scope, channel, {
    mode: "bring_your_own",
    phoneNumberId,
    phoneNumber,
    wabaId,
    displayName: input.displayName,
  });
  return {
    connectionId,
    status: "connected",
    phoneNumber: channel.phoneNumber ?? phoneNumber,
    numberOnboardingMode: "bring_your_own",
    alreadyConnected: false,
  };
}

// ---------------------------------------------------------------------------
// 2. ClickAI numbers: bought by a platform admin, connected by the customer

export async function searchNumbers(
  input: { country: string },
  deps: { vobiz: Vobiz },
): Promise<string[]> {
  const country = requireCountry(input.country);
  try {
    return await deps.vobiz.searchAvailableNumbers({ country });
  } catch (err) {
    throw fromVobiz(err);
  }
}

function requireCountry(value: string): string {
  const country = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new WhatsAppOnboardingError("Choose a country.", "invalid_input");
  }
  return country;
}

export interface WhatsAppNumberOrderView {
  id: string;
  phoneNumber: string;
  status: string;
  failureReason: string | null;
  vobizOrderId: string | null;
  /** The phone_numbers row the purchase created, once recorded. */
  inventoryNumberId: string | null;
  createdAt: string;
}

function orderView(row: {
  id: string;
  phone_number: string;
  status: string;
  failure_reason: string | null;
  vobiz_order_id: string | null;
  phone_number_inventory_id: string | null;
  created_at: string;
}): WhatsAppNumberOrderView {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    status: row.status,
    failureReason: row.failure_reason,
    vobizOrderId: row.vobiz_order_id,
    inventoryNumberId: row.phone_number_inventory_id,
    createdAt: row.created_at,
  };
}

const ORDER_COLUMNS =
  "id, phone_number, status, failure_reason, vobiz_order_id, phone_number_inventory_id, created_at";
const LIVE_ORDER_STATUSES = ["requested", "pending", "completed", "unknown"];

/**
 * Buys a WhatsApp number through ClickAI's Vobiz account for one
 * organization. Platform admins only — the caller must have run
 * assertPlatformAdmin(…, "numbers.write"); customers have no path here.
 *
 * - Refused up front if ClickAI already holds the number (any
 *   organization) or a customer has it live on WhatsApp.
 * - The 'requested' order row is the purchase lock, unique per number
 *   platform-wide: a double click, a retry or a second admin finds the
 *   existing order instead of buying again.
 * - No usable response from Vobiz → 'unknown', never retried here.
 * - Accepted → record_whatsapp_number_purchase records the order and
 *   creates the organization's inventory number ('provisioning', WhatsApp
 *   only) in one transaction. If that fails, the 'requested' lock stays
 *   (the number can't be bought again) and both ids are logged for support.
 */
export async function purchaseNumberForOrganization(
  admin: Client,
  input: { organizationId: string; phoneNumber: string; country: string; requestedBy: string },
  deps: { vobiz: Vobiz },
): Promise<WhatsAppNumberOrderView & { alreadyOrdered: boolean }> {
  const phoneNumber = requireE164(input.phoneNumber);
  const country = requireCountry(input.country);

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id")
    .eq("id", input.organizationId)
    .maybeSingle();
  if (orgError) throw orgError;
  if (!org) throw new WhatsAppOnboardingError("Client not found.", "not_found");

  const { data: lock, error: lockError } = await admin
    .from("whatsapp_number_orders")
    .insert({
      organization_id: null,
      business_id: null,
      requested_by: input.requestedBy,
      phone_number: phoneNumber,
      status: "requested",
    })
    .select(ORDER_COLUMNS)
    .single();
  if (lockError) {
    if ((lockError as { code?: string }).code !== "23505") throw lockError;
    const { data: live, error: liveError } = await admin
      .from("whatsapp_number_orders")
      .select(ORDER_COLUMNS)
      .eq("phone_number", phoneNumber)
      .in("status", LIVE_ORDER_STATUSES)
      .maybeSingle();
    if (liveError) throw liveError;
    if (!live) throw lockError;
    return { ...orderView(live), alreadyOrdered: true };
  }

  const release = async (failureReason: string) => {
    await admin
      .from("whatsapp_number_orders")
      .update({ status: "failed", failure_reason: failureReason.slice(0, 500) })
      .eq("id", lock.id)
      .eq("status", "requested");
  };

  // Checked under the lock, so a concurrent purchase can't slip between.
  const { data: held, error: heldError } = await admin
    .from("phone_numbers")
    .select("id")
    .in("e164", numberForms(phoneNumber))
    .not("status", "in", "(released,failed)")
    .limit(1);
  if (heldError) {
    await release("Couldn't check the inventory; nothing was bought.");
    throw heldError;
  }
  const { data: customerOwned, error: ownedError } = await admin
    .from("whatsapp_connections")
    .select("id")
    .in("display_phone_number", numberForms(phoneNumber))
    .neq("status", "disconnected")
    .limit(1);
  if (ownedError) {
    await release("Couldn't check existing connections; nothing was bought.");
    throw ownedError;
  }
  if ((held ?? []).length > 0 || (customerOwned ?? []).length > 0) {
    await release("Already held by ClickAI or connected by a customer; nothing was bought.");
    throw new WhatsAppOnboardingError(
      "ClickAI already holds this number, or a customer has it connected to WhatsApp.",
      "duplicate_phone_number",
    );
  }

  let order: Awaited<ReturnType<Vobiz["createNumberOrder"]>>;
  try {
    order = await deps.vobiz.createNumberOrder({ phoneNumber });
  } catch (err) {
    if (err instanceof VobizApiError && err.isRejection) {
      await release(err.message);
      throw fromVobiz(err);
    }
    if (err instanceof VobizApiError && err.isRetryable) {
      // Vobiz answered 429 (rate limited): it didn't take the order. Release the lock.
      await release("Vobiz was rate limiting requests; nothing was bought.");
      throw fromVobiz(err);
    }
    // No (usable) response, or a 5xx: Vobiz may or may not have bought it.
    // Never retry blindly.
    await admin
      .from("whatsapp_number_orders")
      .update({
        status: "unknown",
        failure_reason:
          "Vobiz didn't confirm this order. It may still have been placed; check the Vobiz account before ordering again.",
      })
      .eq("id", lock.id)
      .eq("status", "requested");
    throw new WhatsAppOnboardingError(
      "Vobiz didn't confirm the order. It may still have been placed — check the Vobiz account before trying again.",
      "provider_unavailable",
    );
  }

  if (order.status === "failed" || order.status === "cancelled") {
    const { data: closed, error } = await admin
      .from("whatsapp_number_orders")
      .update({
        status: order.status,
        vobiz_order_id: order.id,
        failure_reason: order.failureReason?.slice(0, 500) ?? null,
      })
      .eq("id", lock.id)
      .select(ORDER_COLUMNS)
      .single();
    if (error) {
      console.error("whatsapp_number_order:unrecorded", {
        orderRowId: lock.id,
        vobizOrderId: order.id,
      });
      throw error;
    }
    return { ...orderView(closed), alreadyOrdered: false };
  }

  // Vobiz accepted (and charges for) the order.
  const { data: numberId, error: recordError } = await admin.rpc(
    "record_whatsapp_number_purchase",
    {
      _order_id: lock.id,
      _organization_id: input.organizationId,
      _vobiz_order_id: order.id,
      _order_status: order.status === "completed" ? "completed" : "pending",
      _country: country,
      _provisioned_by: input.requestedBy,
    },
  );
  if (recordError || !numberId) {
    console.error("whatsapp_number_order:unrecorded", {
      orderRowId: lock.id,
      vobizOrderId: order.id,
    });
    throw new WhatsAppOnboardingError(
      `Vobiz accepted the order (${order.id}), but ClickAI couldn't record it. Don't order again — reconcile order ${lock.id}.`,
      "provider_unavailable",
    );
  }
  const { data: recorded, error } = await admin
    .from("whatsapp_number_orders")
    .select(ORDER_COLUMNS)
    .eq("id", lock.id)
    .single();
  if (error) throw error;
  return { ...orderView(recorded), alreadyOrdered: false };
}

/** Recent purchases, for the platform admin (orders are platform records, not tenant data). */
export async function listNumberOrders(admin: Client): Promise<WhatsAppNumberOrderView[]> {
  const { data, error } = await admin
    .from("whatsapp_number_orders")
    .select(ORDER_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map(orderView);
}

/**
 * Connects a ClickAI number assigned to this organization to the
 * customer's WhatsApp Business Account. The number must be in this
 * organization's inventory, WhatsApp-capable and activated by an admin.
 */
export async function connectAssignedNumber(
  admin: Client,
  scope: WhatsAppManagerScope,
  input: { numberId: string; wabaId: string; displayName?: string | null | undefined },
  deps: { vobiz: Vobiz },
): Promise<ConnectedWhatsAppNumber> {
  const wabaId = requireMetaId(input.wabaId, "WhatsApp Business Account ID");
  const { data: number, error } = await admin
    .from("phone_numbers")
    .select("id, e164, status, whatsapp_capable")
    .eq("id", input.numberId)
    .eq("organization_id", scope.organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!number || !number.whatsapp_capable || ["released", "failed"].includes(number.status)) {
    throw new WhatsAppOnboardingError("That number isn't assigned to this workspace.", "not_found");
  }
  if (number.status !== "active") {
    throw new WhatsAppOnboardingError(
      "ClickAI is still setting this number up. Try again once it shows as active.",
      "order_not_ready",
    );
  }

  const { data: live, error: liveError } = await admin
    .from("whatsapp_connections")
    .select("id")
    .eq("inventory_number_id", number.id)
    .eq("organization_id", scope.organizationId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (liveError) throw liveError;
  if (live) {
    return {
      connectionId: live.id,
      status: "connected",
      phoneNumber: number.e164,
      numberOnboardingMode: "buy_from_vobiz",
      alreadyConnected: true,
    };
  }

  const { data: order, error: orderError } = await admin
    .from("whatsapp_number_orders")
    .select("vobiz_order_id, status")
    .eq("phone_number_inventory_id", number.id)
    .maybeSingle();
  if (orderError) throw orderError;
  if (!order?.vobiz_order_id || !["pending", "completed"].includes(order.status)) {
    throw new WhatsAppOnboardingError(
      "This number's purchase isn't complete yet. Contact ClickAI support.",
      "order_not_ready",
    );
  }

  let channel: VobizChannel;
  try {
    channel = await createOrRecover(
      deps.vobiz,
      () =>
        deps.vobiz.createChannel({
          mode: "buy_from_vobiz",
          wabaId,
          numberOrderId: order.vobiz_order_id!,
          phoneNumber: number.e164,
          displayName: input.displayName ?? undefined,
        }),
      { numberOrderId: order.vobiz_order_id, phoneNumber: number.e164, wabaId },
    );
  } catch (err) {
    const e = fromVobiz(err);
    // Vobiz only links a completed order; until then it refuses.
    if (e.code === "provider_rejected") {
      throw new WhatsAppOnboardingError(
        `${e.message} If the number is still being set up, try again in a few minutes.`,
        "order_not_ready",
      );
    }
    throw e;
  }
  const connectionId = await persistChannel(admin, scope, channel, {
    mode: "buy_from_vobiz",
    phoneNumberId: null,
    phoneNumber: number.e164,
    wabaId,
    displayName: input.displayName,
    numberOrderId: order.vobiz_order_id,
    inventoryNumberId: number.id,
  });
  return {
    connectionId,
    status: "connected",
    phoneNumber: channel.phoneNumber ?? number.e164,
    numberOnboardingMode: "buy_from_vobiz",
    alreadyConnected: false,
  };
}

/**
 * Asks ClickAI for a WhatsApp number — the same customer_events request
 * queue the voice "Get a number" request uses (telephony-customer.functions
 * .ts), read by admins on Customer 360. Nothing is bought here.
 */
export async function requestClickAiNumber(
  admin: Client,
  scope: WhatsAppManagerScope,
  input: { actorEmail: string | null },
): Promise<{ alreadyHasNumber: boolean; alreadyRequested: boolean }> {
  const { data: assigned, error } = await admin
    .from("phone_numbers")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("whatsapp_capable", true)
    .not("status", "in", "(released,failed)")
    .limit(1);
  if (error) throw error;
  if ((assigned ?? []).length > 0) return { alreadyHasNumber: true, alreadyRequested: false };

  const { data: previous, error: previousError } = await admin
    .from("customer_events")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("kind", "whatsapp_number_requested")
    .limit(1);
  if (previousError) throw previousError;
  if ((previous ?? []).length > 0) return { alreadyHasNumber: false, alreadyRequested: true };

  const { error: insertError } = await admin.from("customer_events").insert({
    organization_id: scope.organizationId,
    kind: "whatsapp_number_requested",
    title: "Customer requested a WhatsApp number",
    detail: "Buy one from the admin Phone numbers page and activate it for this workspace.",
    actor_email: input.actorEmail,
  });
  if (insertError) throw insertError;
  return { alreadyHasNumber: false, alreadyRequested: false };
}

// ---------------------------------------------------------------------------
// 3. Embedded Signup through Vobiz

export async function completeEmbeddedSignup(
  admin: Client,
  scope: WhatsAppManagerScope,
  input: { code: string; wabaId: string; phoneNumberId: string },
  deps: { vobiz: Vobiz },
): Promise<ConnectedWhatsAppNumber> {
  const code = input.code.trim();
  if (!code)
    throw new WhatsAppOnboardingError("Meta didn't return an authorization code.", "invalid_input");
  const wabaId = requireMetaId(input.wabaId, "WhatsApp Business Account ID");
  const phoneNumberId = requireMetaId(input.phoneNumberId, "Phone number ID");

  const existing = await guardPhoneNumber(admin, scope, phoneNumberId);
  if (existing && existing.provider === "vobiz" && existing.vobiz_channel_id) {
    return {
      connectionId: existing.id,
      status: "connected",
      phoneNumber: existing.display_phone_number,
      numberOnboardingMode: "embedded_signup",
      alreadyConnected: true,
    };
  }

  const channel = await createOrRecover(
    deps.vobiz,
    () => deps.vobiz.completeEmbeddedSignup({ code, wabaId, phoneNumberId }),
    { phoneNumberId, wabaId },
  );
  const connectionId = await persistChannel(admin, scope, channel, {
    mode: "embedded_signup",
    phoneNumberId,
    phoneNumber: null,
    wabaId,
  });
  return {
    connectionId,
    status: "connected",
    phoneNumber: channel.phoneNumber,
    numberOnboardingMode: "embedded_signup",
    alreadyConnected: false,
  };
}

// ---------------------------------------------------------------------------
// Reconnect

/**
 * Brings a disconnected Vobiz connection back, if its channel still exists
 * at Vobiz and the number isn't live for anyone else meanwhile. (Disconnect
 * only stops ClickAI from using the number; the Vobiz channel is kept.)
 */
export async function reconnectConnection(
  admin: Client,
  scope: WhatsAppManagerScope & { connectionId: string },
  deps: { vobiz: Vobiz },
): Promise<{ connectionId: string; status: "connected" }> {
  const { data: conn, error } = await admin
    .from("whatsapp_connections")
    .select("id, organization_id, status, provider, vobiz_channel_id, phone_number_id")
    .eq("id", scope.connectionId)
    .eq("organization_id", scope.organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!conn) throw new WhatsAppOnboardingError("WhatsApp connection not found.", "not_found");
  if (conn.status === "connected") return { connectionId: conn.id, status: "connected" };
  if (conn.provider !== "vobiz" || !conn.vobiz_channel_id) {
    throw new WhatsAppOnboardingError(
      "This number was connected with the old Meta setup. Connect it again through Vobiz.",
      "invalid_input",
    );
  }
  const live = await findLiveByPhoneNumberId(admin, conn.phone_number_id);
  if (live && live.id !== conn.id) {
    throw new WhatsAppOnboardingError(
      "This WhatsApp number is connected elsewhere now. Disconnect it there first.",
      "duplicate_phone_number",
    );
  }
  let channels: VobizChannel[];
  try {
    channels = await deps.vobiz.listChannels();
  } catch (err) {
    throw fromVobiz(err);
  }
  if (!channels.some((c) => c.id === conn.vobiz_channel_id)) {
    throw new WhatsAppOnboardingError(
      "Vobiz no longer has this channel. Connect the number again.",
      "not_found",
    );
  }
  const { error: updateError } = await admin
    .from("whatsapp_connections")
    .update({
      status: "connected",
      disconnected_at: null,
      last_connected_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", conn.id)
    .eq("organization_id", scope.organizationId);
  if (updateError) {
    if ((updateError as { code?: string }).code === "23505") {
      throw new WhatsAppOnboardingError(
        "This WhatsApp number is connected elsewhere now. Disconnect it there first.",
        "duplicate_phone_number",
      );
    }
    // E.g. a ClickAI number that has since been reassigned to another workspace.
    throw ownershipError(updateError) ?? updateError;
  }
  return { connectionId: conn.id, status: "connected" };
}
