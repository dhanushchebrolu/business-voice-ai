/**
 * Google Calendar -> ClickAI sync and reconciliation (hospital calendar
 * spec section 6, "Google Calendar to ClickAI"). This is the ONLY code
 * path in the codebase that reads external_calendar_events/
 * calendar_sync_conflicts as a WRITE target; the dashboard and availability
 * lookups only ever read them.
 *
 * Core separation principle (explicit project instruction): Google
 * Calendar is the source of external BUSY events; ClickAI's own
 * `bookings` table stays authoritative for patient bookings. This file
 * never writes to `bookings` — an external change can, at most, cause a
 * `calendar_sync_conflicts` row to be recorded for staff to resolve; it can
 * never cancel, modify, or delete a booking.
 *
 * Loop prevention (spec: "prevent an update loop in which ClickAI changes
 * an event, receives its own change notification, and repeatedly writes
 * the same update back"): this module NEVER calls
 * provider.createEvent/updateEvent/deleteEvent. It only ever writes to
 * ClickAI's own cache tables (external_calendar_events,
 * calendar_sync_conflicts) and to google_calendar_connections' own sync
 * bookkeeping columns. With no write-back path to Google at all, a
 * self-triggered notification loop is impossible by construction, not by
 * origin-metadata bookkeeping that could itself have a bug.
 *
 * ClickAI-origin detection: an external event is "ClickAI-managed" if and
 * only if some (non-cancelled) booking's own google_event_id exactly
 * matches it — never inferred from title, time, or any other heuristic
 * (spec: "do not associate an unknown event with a patient booking by
 * guesswork").
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  GoogleCalendarProvider,
  type RawGoogleSyncEvent,
} from "../calendar/google-calendar-provider.server.ts";
import { CalendarProviderError } from "../calendar/calendar-provider.ts";
import {
  getValidGoogleAccessToken,
  GoogleCalendarConnectionError,
} from "./google-calendar-connection.server.ts";
import { resolveGoogleCalendarWebhookUrl } from "./google-calendar-config.server.ts";

type Client = SupabaseClient<Database>;

/** Renew a channel once less than this much runway remains, never waiting until the last minute. */
const CHANNEL_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface WebhookNotificationHeaders {
  channelId: string | null;
  channelToken: string | null;
  resourceState: string | null; // "sync" | "exists" | "not_exists"
}

export interface WebhookOutcome {
  outcome: "ignored" | "synced" | "rejected";
  reason?: string;
}

export interface SyncResult {
  processedEvents: number;
  conflicts: number;
  fullResync: boolean;
}

/**
 * Registers (or re-registers, if nearing expiry) a push-notification
 * channel for a CONNECTED connection. A no-op for a disconnected
 * connection or one with no calendar selected yet, and a no-op when the
 * existing channel still has enough runway — safe to call on every cron
 * tick without causing needless channel churn.
 */
export async function ensureWatchChannel(
  supabaseAdmin: Client,
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ renewed: boolean }> {
  const { data: connection, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, calendar_id, status, channel_id, channel_resource_id, channel_expiration")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw error;
  if (!connection || connection.status !== "CONNECTED" || !connection.calendar_id) {
    return { renewed: false };
  }

  const expiresAtMs = connection.channel_expiration
    ? new Date(connection.channel_expiration).getTime()
    : 0;
  if (expiresAtMs - Date.now() > CHANNEL_RENEWAL_THRESHOLD_MS) {
    return { renewed: false };
  }

  const webhookUrl = resolveGoogleCalendarWebhookUrl();
  if (!webhookUrl) {
    throw new GoogleCalendarConnectionError(
      "GOOGLE_CALENDAR_WEBHOOK_URL is not configured; cannot register a Google Calendar push-notification channel.",
      "NOT_CONFIGURED",
    );
  }

  const { accessToken } = await getValidGoogleAccessToken(supabaseAdmin, connectionId, fetchImpl);
  const provider = new GoogleCalendarProvider({ accessToken, fetchImpl });

  const previousChannelId = connection.channel_id;
  const previousResourceId = connection.channel_resource_id;

  const newChannelId = randomUUID();
  const newChannelToken = randomUUID();
  const { resourceId, expirationMs } = await provider.watchEvents(
    connection.calendar_id,
    newChannelId,
    newChannelToken,
    webhookUrl,
  );

  await supabaseAdmin
    .from("google_calendar_connections")
    .update({
      channel_id: newChannelId,
      channel_resource_id: resourceId,
      channel_token: newChannelToken,
      channel_expiration: new Date(expirationMs).toISOString(),
    })
    .eq("id", connectionId);

  // Best-effort cleanup of the superseded channel — not calling this is
  // harmless (the old channel just expires on its own), so a failure here
  // must never fail the renewal that already succeeded above.
  if (previousChannelId && previousResourceId) {
    await provider.stopChannel(previousChannelId, previousResourceId).catch(() => {});
  }

  return { renewed: true };
}

/**
 * Webhook entry point. Verifies the channel exists and the token matches
 * before doing any sync work (Google's push notifications carry no
 * cryptographic signature; the channel token is the actual authentication
 * mechanism — see the channel_token migration's own doc comment). A
 * resourceState of "sync" is Google's initial handshake confirming channel
 * registration, not an actual calendar change, and is ignored.
 */
export async function handleWebhookNotification(
  supabaseAdmin: Client,
  headers: WebhookNotificationHeaders,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookOutcome> {
  if (!headers.channelId) return { outcome: "rejected", reason: "missing channel id" };

  const { data: connection, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, channel_token, status")
    .eq("channel_id", headers.channelId)
    .maybeSingle();
  if (error) throw error;
  if (!connection) return { outcome: "rejected", reason: "unknown channel" };
  if (!connection.channel_token || connection.channel_token !== headers.channelToken) {
    return { outcome: "rejected", reason: "channel token mismatch" };
  }
  if (connection.status !== "CONNECTED") {
    return { outcome: "ignored", reason: "connection is not active" };
  }
  if (headers.resourceState === "sync") {
    return { outcome: "ignored", reason: "channel registration handshake" };
  }

  await syncConnection(supabaseAdmin, connection.id, fetchImpl);
  return { outcome: "synced" };
}

/**
 * The core incremental sync pass for one connection: fetches everything
 * that changed since the stored sync_token (or bootstraps a fresh window
 * when there is none / it expired), reconciles each event against
 * ClickAI's own state, and persists the new sync_token. Idempotent and
 * safe to call repeatedly for the same connection — a duplicate or
 * out-of-order notification just re-processes the same (or an empty) set
 * of changes with no additional effect (reconcileExternalEvent's own
 * upserts and conflict-dedup make every step idempotent).
 */
export async function syncConnection(
  supabaseAdmin: Client,
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult> {
  const { data: connection, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, organization_id, business_id, calendar_id, sync_token")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw error;
  if (!connection || !connection.calendar_id) {
    throw new GoogleCalendarConnectionError(
      "Google Calendar connection not found or has no calendar selected.",
      "NOT_FOUND",
    );
  }

  const { accessToken } = await getValidGoogleAccessToken(supabaseAdmin, connectionId, fetchImpl);
  const provider = new GoogleCalendarProvider({ accessToken, fetchImpl });

  let syncToken: string | undefined = connection.sync_token ?? undefined;
  let pageToken: string | undefined;
  let fullResync = !syncToken;
  let retriedAfterExpiry = false;
  let processedEvents = 0;
  let conflicts = 0;
  let finalSyncToken: string | null = null;

  for (;;) {
    let page;
    try {
      page = await provider.listEventsPage(connection.calendar_id, {
        syncToken,
        pageToken,
        timeMinIso: syncToken ? undefined : new Date().toISOString(),
      });
    } catch (err) {
      if (
        err instanceof CalendarProviderError &&
        err.code === "SYNC_TOKEN_EXPIRED" &&
        !retriedAfterExpiry
      ) {
        // Discard the stale token and restart as a full resync, exactly
        // once — Google's documented recovery from an expired sync token.
        retriedAfterExpiry = true;
        syncToken = undefined;
        pageToken = undefined;
        fullResync = true;
        continue;
      }
      throw err;
    }

    for (const event of page.events) {
      const didConflict = await reconcileExternalEvent(supabaseAdmin, connection, event);
      processedEvents++;
      if (didConflict) conflicts++;
    }

    if (page.nextSyncToken) finalSyncToken = page.nextSyncToken;
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  if (finalSyncToken) {
    await supabaseAdmin
      .from("google_calendar_connections")
      .update({
        sync_token: finalSyncToken,
        last_sync_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", connectionId);
  }

  return { processedEvents, conflicts, fullResync };
}

/**
 * Reconciles one external event against ClickAI's state. Always upserts
 * external_calendar_events (ClickAI's cache of "what Google currently
 * says"), and — only when the event is traceable to a specific ClickAI
 * booking by exact google_event_id match — detects an EXTERNALLY_DELETED
 * or EXTERNALLY_MODIFIED conflict and records it for staff review.
 * Returns true when a conflict was recorded (new or already-open), for
 * the caller's summary counters.
 */
export async function reconcileExternalEvent(
  supabaseAdmin: Client,
  connection: { id: string; organization_id: string; business_id: string },
  event: RawGoogleSyncEvent,
): Promise<boolean> {
  const { data: linkedBooking, error: bookingLookupError } = await supabaseAdmin
    .from("bookings")
    .select("id, start_at, end_at, status")
    .eq("organization_id", connection.organization_id)
    .eq("google_event_id", event.id)
    .not("status", "in", "(CANCELLED,NO_SHOW)")
    .maybeSingle();
  if (bookingLookupError) throw bookingLookupError;

  const isAllDay = Boolean(event.start?.date && !event.start?.dateTime);
  const startAt =
    event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00.000Z` : null);
  const endAt = event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00.000Z` : null);

  const { error: upsertError } = await supabaseAdmin.from("external_calendar_events").upsert(
    {
      organization_id: connection.organization_id,
      business_id: connection.business_id,
      calendar_connection_id: connection.id,
      google_event_id: event.id,
      status: event.status,
      start_at: startAt,
      end_at: endAt,
      is_all_day: isAllDay,
      linked_booking_id: linkedBooking?.id ?? null,
      is_clickai_managed: Boolean(linkedBooking),
      raw_updated_at: event.updated ?? null,
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: "calendar_connection_id,google_event_id" },
  );
  if (upsertError) throw upsertError;

  // A plain external event (not traceable to any ClickAI booking) only
  // ever affects the busy-period cache above — never a candidate for a
  // conflict row, per "do not associate with a patient booking by
  // guesswork".
  if (!linkedBooking) return false;

  let conflictType: "EXTERNALLY_DELETED" | "EXTERNALLY_MODIFIED" | null = null;
  let details: Record<string, string | null> = {};

  if (event.status === "cancelled") {
    conflictType = "EXTERNALLY_DELETED";
    details = {
      googleEventId: event.id,
      bookingStartAt: linkedBooking.start_at,
      bookingEndAt: linkedBooking.end_at,
    };
  } else if (
    startAt &&
    endAt &&
    (new Date(startAt).getTime() !== new Date(linkedBooking.start_at).getTime() ||
      new Date(endAt).getTime() !== new Date(linkedBooking.end_at).getTime())
  ) {
    conflictType = "EXTERNALLY_MODIFIED";
    details = {
      googleEventId: event.id,
      bookingStartAt: linkedBooking.start_at,
      bookingEndAt: linkedBooking.end_at,
      externalStartAt: startAt,
      externalEndAt: endAt,
    };
  }

  if (!conflictType) return false;

  // Idempotent: a repeated or out-of-order notification for the same
  // change must not spam a second OPEN conflict row for the same booking.
  const { data: existingConflict, error: existingConflictError } = await supabaseAdmin
    .from("calendar_sync_conflicts")
    .select("id")
    .eq("booking_id", linkedBooking.id)
    .eq("calendar_connection_id", connection.id)
    .eq("conflict_type", conflictType)
    .eq("status", "OPEN")
    .maybeSingle();
  if (existingConflictError) throw existingConflictError;
  if (existingConflict) return true;

  const { error: insertConflictError } = await supabaseAdmin
    .from("calendar_sync_conflicts")
    .insert({
      organization_id: connection.organization_id,
      business_id: connection.business_id,
      booking_id: linkedBooking.id,
      calendar_connection_id: connection.id,
      google_event_id: event.id,
      conflict_type: conflictType,
      details,
    });
  if (insertConflictError) throw insertConflictError;
  return true;
}

/**
 * Periodic reconciliation sweep (cron) — renews channels approaching
 * expiry and re-syncs every CONNECTED connection, catching anything a
 * missed, delayed, or never-delivered webhook notification would have
 * caught. One connection's failure never stops the sweep for the rest.
 */
export async function runPeriodicGoogleCalendarSync(
  supabaseAdmin: Client,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  connectionsProcessed: number;
  channelsRenewed: number;
  errors: { connectionId: string; message: string }[];
}> {
  const { data: connections, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id")
    .eq("status", "CONNECTED")
    .eq("provider", "google");
  if (error) throw error;

  let channelsRenewed = 0;
  const errors: { connectionId: string; message: string }[] = [];

  for (const { id } of connections ?? []) {
    try {
      const { renewed } = await ensureWatchChannel(supabaseAdmin, id, fetchImpl);
      if (renewed) channelsRenewed++;
      await syncConnection(supabaseAdmin, id, fetchImpl);
    } catch (err) {
      errors.push({
        connectionId: id,
        message: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return { connectionsProcessed: (connections ?? []).length, channelsRenewed, errors };
}
