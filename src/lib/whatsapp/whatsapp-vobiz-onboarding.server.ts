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
 *   2. Buy a number through Vobiz ('buy_from_vobiz'): search availability,
 *      place an order (a purchase-lock row is written first, so a repeat can
 *      never buy twice), then create the channel from the completed order.
 *   3. Embedded Signup through Vobiz ('embedded_signup'): the browser runs
 *      Meta's Embedded Signup popup with the Meta app Vobiz exchanges codes
 *      for, and the resulting OAuth code + WABA id are handed to Vobiz.
 *
 * Callers own authentication and authorization: every function here takes
 * a scope already resolved by requireWhatsAppManager (owner/admin of the
 * target business's organization) and a Vobiz client. All writes use the
 * service role and filter by that scope's organization explicitly.
 *
 * Partial failures: a channel Vobiz created during a request whose response
 * was lost (timeout, network, conflict) is found again with
 * `GET /channels/whatsapp` and adopted, so a retry never needs a second
 * channel. A number already live for another organization is refused
 * before Vobiz is asked to do anything.
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
    | "incomplete_channel";
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

/** After a lost/conflicting response: the channel Vobiz may already have created for this number. */
async function recoverChannel(
  vobiz: Vobiz,
  match: {
    phoneNumberId?: string | null;
    phoneNumber?: string | null;
    numberOrderId?: string | null;
  },
): Promise<VobizChannel | null> {
  let channels: VobizChannel[];
  try {
    channels = await vobiz.listChannels();
  } catch {
    return null;
  }
  return (
    channels.find(
      (c) =>
        (match.phoneNumberId && c.phoneNumberId === match.phoneNumberId) ||
        (match.numberOrderId && c.numberOrderId === match.numberOrderId) ||
        (match.phoneNumber && c.phoneNumber === match.phoneNumber),
    ) ?? null
  );
}

/** Creates the channel, adopting one Vobiz already made if the response was lost or conflicted. */
async function createOrRecover(
  vobiz: Vobiz,
  create: () => Promise<VobizChannel>,
  match: Parameters<typeof recoverChannel>[1],
): Promise<VobizChannel> {
  try {
    return await create();
  } catch (err) {
    const recoverable =
      err instanceof VobizApiError &&
      (err.kind !== "http" || err.status === 409 || err.isRetryable);
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
  },
): Promise<string> {
  const phoneNumberId = channel.phoneNumberId ?? input.phoneNumberId;
  if (!phoneNumberId) {
    throw new WhatsAppOnboardingError(
      `Vobiz created the channel (${channel.id}) but didn't return its WhatsApp phone number id, so ClickAI can't route its messages yet. Contact support with this channel id.`,
      "incomplete_channel",
    );
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
    if (error) throw error;
    return existing.id;
  }
  const { data, error } = await admin
    .from("whatsapp_connections")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new WhatsAppOnboardingError(
        "This WhatsApp number is already connected to a different ClickAI account.",
        "duplicate_phone_number",
      );
    }
    throw error;
  }
  return data.id;
}

// ---------------------------------------------------------------------------
// 1. Bring your own number

export async function startByonVerification(
  admin: Client,
  scope: WhatsAppManagerScope,
  input: { phoneNumber: string; method: "sms" | "voice" },
  deps: { vobiz: Vobiz; now?: () => Date },
): Promise<{ phoneNumber: string }> {
  const phoneNumber = requireE164(input.phoneNumber);
  const now = (deps.now ?? (() => new Date()))();
  const { count, error } = await admin
    .from("customer_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", scope.organizationId)
    .eq("kind", "whatsapp_byon_otp_requested")
    .gte("created_at", new Date(now.getTime() - 60 * 60_000).toISOString());
  if (error) throw error;
  if ((count ?? 0) >= BYON_OTP_REQUESTS_PER_HOUR) {
    throw new WhatsAppOnboardingError(
      "Too many verification codes requested. Please wait an hour and try again.",
      "rate_limited",
    );
  }
  try {
    await deps.vobiz.startByonVerification({ phoneNumber, method: input.method });
  } catch (err) {
    throw fromVobiz(err);
  }
  const { error: logError } = await admin.from("customer_events").insert({
    organization_id: scope.organizationId,
    kind: "whatsapp_byon_otp_requested",
    title: "WhatsApp number verification code requested",
    detail: `${phoneNumber} via ${input.method}`,
    metadata: { method: input.method },
  });
  if (logError) throw logError;
  return { phoneNumber };
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
  deps: { vobiz: Vobiz },
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

  try {
    await deps.vobiz.confirmByonVerification({ phoneNumber, otpCode });
  } catch (err) {
    throw fromVobiz(err);
  }
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
    { phoneNumberId, phoneNumber },
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
// 2. Buy a number through Vobiz

export async function searchNumbers(
  input: { country: string },
  deps: { vobiz: Vobiz },
): Promise<string[]> {
  const country = input.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new WhatsAppOnboardingError("Choose a country.", "invalid_input");
  }
  try {
    return await deps.vobiz.searchAvailableNumbers({ country });
  } catch (err) {
    throw fromVobiz(err);
  }
}

export interface WhatsAppNumberOrderView {
  id: string;
  phoneNumber: string;
  status: string;
  failureReason: string | null;
  connectionId: string | null;
}

function orderView(row: {
  id: string;
  phone_number: string;
  status: string;
  failure_reason: string | null;
  whatsapp_connection_id: string | null;
}): WhatsAppNumberOrderView {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    status: row.status,
    failureReason: row.failure_reason,
    connectionId: row.whatsapp_connection_id,
  };
}

const ORDER_COLUMNS =
  "id, phone_number, status, failure_reason, whatsapp_connection_id, vobiz_order_id";

/**
 * Buys a number. The 'requested' row is the purchase lock (unique per
 * organization and number while live): a double click or a retry finds the
 * existing order instead of buying again. A request whose outcome is
 * unknown (no response) is marked 'unknown' and never retried here.
 */
export async function orderNumber(
  admin: Client,
  scope: WhatsAppManagerScope,
  input: { phoneNumber: string; requestedBy: string },
  deps: { vobiz: Vobiz },
): Promise<WhatsAppNumberOrderView & { alreadyOrdered: boolean }> {
  const phoneNumber = requireE164(input.phoneNumber);
  const { data: lock, error: lockError } = await admin
    .from("whatsapp_number_orders")
    .insert({
      organization_id: scope.organizationId,
      business_id: scope.businessId,
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
      .eq("organization_id", scope.organizationId)
      .eq("phone_number", phoneNumber)
      .in("status", ["requested", "pending", "completed", "unknown"])
      .maybeSingle();
    if (liveError) throw liveError;
    if (!live) throw lockError;
    return { ...orderView(live), alreadyOrdered: true };
  }

  try {
    const order = await deps.vobiz.createNumberOrder({ phoneNumber });
    const status = ["pending", "completed", "failed", "cancelled"].includes(order.status)
      ? order.status
      : "pending";
    const { data: updated, error } = await admin
      .from("whatsapp_number_orders")
      .update({
        status,
        vobiz_order_id: order.id,
        failure_reason: order.failureReason?.slice(0, 500) ?? null,
      })
      .eq("id", lock.id)
      .eq("organization_id", scope.organizationId)
      .select(ORDER_COLUMNS)
      .single();
    if (error) throw error;
    return { ...orderView(updated), alreadyOrdered: false };
  } catch (err) {
    if (err instanceof VobizApiError && err.isRejection) {
      await admin
        .from("whatsapp_number_orders")
        .update({ status: "failed", failure_reason: err.message.slice(0, 500) })
        .eq("id", lock.id)
        .eq("organization_id", scope.organizationId);
      throw fromVobiz(err);
    }
    if (err instanceof VobizApiError && err.isRetryable) {
      // Vobiz answered 429/5xx: it didn't take the order. Release the lock.
      await admin
        .from("whatsapp_number_orders")
        .update({ status: "failed", failure_reason: "Vobiz was unavailable; nothing was bought." })
        .eq("id", lock.id)
        .eq("organization_id", scope.organizationId);
      throw fromVobiz(err);
    }
    // No (usable) response: Vobiz may or may not have bought it. Never retry blindly.
    await admin
      .from("whatsapp_number_orders")
      .update({
        status: "unknown",
        failure_reason:
          "Vobiz didn't confirm this order. It may still have been placed; check with support before ordering again.",
      })
      .eq("id", lock.id)
      .eq("organization_id", scope.organizationId);
    throw new WhatsAppOnboardingError(
      "Vobiz didn't confirm the order. It may still have been placed — please contact support before trying again.",
      "provider_unavailable",
    );
  }
}

export async function listNumberOrders(
  admin: Client,
  organizationId: string,
): Promise<WhatsAppNumberOrderView[]> {
  const { data, error } = await admin
    .from("whatsapp_number_orders")
    .select(ORDER_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []).map(orderView);
}

/** Creates the channel from a bought number once Vobiz has completed the order. */
export async function connectPurchasedNumber(
  admin: Client,
  scope: WhatsAppManagerScope,
  input: { orderId: string; wabaId: string; displayName?: string | null | undefined },
  deps: { vobiz: Vobiz },
): Promise<ConnectedWhatsAppNumber> {
  const wabaId = requireMetaId(input.wabaId, "WhatsApp Business Account ID");
  const { data: order, error } = await admin
    .from("whatsapp_number_orders")
    .select(ORDER_COLUMNS)
    .eq("id", input.orderId)
    .eq("organization_id", scope.organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!order) throw new WhatsAppOnboardingError("That number order was not found.", "not_found");
  if (order.status === "connected" && order.whatsapp_connection_id) {
    return {
      connectionId: order.whatsapp_connection_id,
      status: "connected",
      phoneNumber: order.phone_number,
      numberOnboardingMode: "buy_from_vobiz",
      alreadyConnected: true,
    };
  }
  if (
    !order.vobiz_order_id ||
    ["failed", "cancelled", "unknown", "requested"].includes(order.status)
  ) {
    throw new WhatsAppOnboardingError(
      "This order can't be connected. Check its status or place a new order.",
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
          phoneNumber: order.phone_number,
          displayName: input.displayName ?? undefined,
        }),
      { numberOrderId: order.vobiz_order_id, phoneNumber: order.phone_number },
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
    phoneNumber: order.phone_number,
    wabaId,
    displayName: input.displayName,
    numberOrderId: order.vobiz_order_id,
  });
  const { error: linkError } = await admin
    .from("whatsapp_number_orders")
    .update({ status: "connected", whatsapp_connection_id: connectionId })
    .eq("id", order.id)
    .eq("organization_id", scope.organizationId);
  if (linkError) throw linkError;
  return {
    connectionId,
    status: "connected",
    phoneNumber: channel.phoneNumber ?? order.phone_number,
    numberOnboardingMode: "buy_from_vobiz",
    alreadyConnected: false,
  };
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
    { phoneNumberId },
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
    throw updateError;
  }
  return { connectionId: conn.id, status: "connected" };
}
