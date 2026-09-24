/**
 * GoogleCalendarProvider — the only CalendarProvider implementation today.
 * Talks to the Google Calendar API v3 over plain REST (no googleapis SDK
 * dependency, matching this codebase's existing pattern of raw-fetch
 * provider clients — see meta-client.server.ts, sarvam-api-client.server.ts).
 *
 * Takes an already-valid access token (minted by google-oauth.server.ts's
 * refreshAccessToken, orchestrated by google-calendar-connection.server.ts)
 * rather than a refresh token — this class only ever makes Calendar API
 * calls, it never does its own token refresh, keeping the two concerns
 * separate and this class trivially testable with a fake fetch.
 */

import {
  CalendarProviderError,
  type CalendarProvider,
  type CalendarListEntry,
  type CalendarBusyPeriod,
  type GetBusyPeriodsInput,
  type CalendarEventInput,
  type NormalizedCalendarEvent,
} from "./calendar-provider.ts";

const API_BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 150;

export interface GoogleCalendarProviderConfig {
  accessToken: string;
  /** Defaults to global fetch — injectable so tests never hit a real network. */
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Injectable so tests don't actually sleep between retries. */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

function mapErrorResponse(
  status: number,
  parsed: GoogleErrorBody | undefined,
): CalendarProviderError {
  const message = parsed?.error?.message;
  switch (status) {
    case 401:
      return new CalendarProviderError(
        "GOOGLE_AUTH_REQUIRED",
        "Google Calendar access has expired or been revoked. Please reconnect.",
      );
    case 403:
      return new CalendarProviderError(
        "CALENDAR_ACCESS_DENIED",
        "ClickAI no longer has permission to access this Google Calendar.",
      );
    case 404:
      return new CalendarProviderError(
        "CALENDAR_NOT_FOUND",
        "That calendar or event could not be found.",
      );
    case 409:
      return new CalendarProviderError(
        "CALENDAR_CONFLICT",
        "That change conflicts with the current calendar state.",
      );
    case 429:
      return new CalendarProviderError(
        "CALENDAR_RATE_LIMITED",
        "Google Calendar is rate-limiting requests right now.",
        true,
      );
    default:
      if (status >= 500) {
        return new CalendarProviderError(
          "CALENDAR_UNAVAILABLE",
          "Google Calendar is temporarily unavailable.",
          true,
        );
      }
      return new CalendarProviderError(
        "CALENDAR_UNAVAILABLE",
        message
          ? `Google Calendar rejected the request: ${message}`
          : "Google Calendar rejected the request.",
      );
  }
}

function mapGoogleEvent(raw: {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
}): NormalizedCalendarEvent {
  return {
    id: raw.id ?? "",
    title: raw.summary ?? "",
    description: raw.description,
    start: raw.start?.dateTime ?? raw.start?.date ?? "",
    end: raw.end?.dateTime ?? raw.end?.date ?? "",
    status:
      raw.status === "cancelled"
        ? "cancelled"
        : raw.status === "tentative"
          ? "tentative"
          : "confirmed",
  };
}

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly config: GoogleCalendarProviderConfig;

  constructor(config: GoogleCalendarProviderConfig) {
    this.config = config;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T | null> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const sleepImpl =
      this.config.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          if (attempt < MAX_RETRIES) {
            attempt++;
            await sleepImpl(RETRY_BASE_DELAY_MS * attempt);
            continue;
          }
          throw new CalendarProviderError(
            "CALENDAR_UNAVAILABLE",
            "Google Calendar did not respond in time.",
            true,
          );
        }
        if (attempt < MAX_RETRIES) {
          attempt++;
          await sleepImpl(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw new CalendarProviderError(
          "CALENDAR_UNAVAILABLE",
          "Could not reach Google Calendar.",
          true,
        );
      }
      clearTimeout(timer);

      if (res.status === 204) return null;

      const rawText = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = rawText ? JSON.parse(rawText) : undefined;
      } catch {
        parsed = undefined;
      }

      if (!res.ok) {
        const mapped = mapErrorResponse(res.status, parsed as GoogleErrorBody | undefined);
        // Only retry transient failures (429/5xx), and only within the retry budget. Never retry auth/permission/not-found/conflict — those will not succeed on a retry and retrying them risks duplicate side effects (e.g. a second POST).
        if (mapped.retryable && attempt < MAX_RETRIES) {
          attempt++;
          await sleepImpl(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw mapped;
      }
      return parsed as T;
    }
  }

  async listCalendars(): Promise<CalendarListEntry[]> {
    const result = await this.request<{
      items?: { id?: string; summary?: string; primary?: boolean }[];
    }>("GET", "/users/me/calendarList");
    return (result?.items ?? [])
      .filter((c): c is { id: string; summary?: string; primary?: boolean } => Boolean(c.id))
      .map((c) => ({ id: c.id, name: c.summary ?? c.id, primary: Boolean(c.primary) }));
  }

  async getBusyPeriods(input: GetBusyPeriodsInput): Promise<CalendarBusyPeriod[]> {
    const result = await this.request<{
      calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
    }>("POST", "/freeBusy", {
      timeMin: input.timeMinIso,
      timeMax: input.timeMaxIso,
      items: [{ id: input.calendarId }],
    });
    return result?.calendars?.[input.calendarId]?.busy ?? [];
  }

  async createEvent(input: CalendarEventInput): Promise<NormalizedCalendarEvent> {
    const result = await this.request<Record<string, unknown>>(
      "POST",
      `/calendars/${encodeURIComponent(input.calendarId)}/events`,
      {
        summary: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        start: { dateTime: input.startIso, timeZone: input.timezone },
        end: { dateTime: input.endIso, timeZone: input.timezone },
      },
    );
    return mapGoogleEvent(result ?? {});
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    input: Partial<CalendarEventInput>,
  ): Promise<NormalizedCalendarEvent> {
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch["summary"] = input.title;
    if (input.description !== undefined) patch["description"] = input.description;
    if (input.startIso !== undefined) {
      patch["start"] = { dateTime: input.startIso, timeZone: input.timezone };
    }
    if (input.endIso !== undefined) {
      patch["end"] = { dateTime: input.endIso, timeZone: input.timezone };
    }
    const result = await this.request<Record<string, unknown>>(
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      patch,
    );
    return mapGoogleEvent(result ?? {});
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  }

  async getEvent(calendarId: string, eventId: string): Promise<NormalizedCalendarEvent | null> {
    try {
      const result = await this.request<Record<string, unknown>>(
        "GET",
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      return result ? mapGoogleEvent(result) : null;
    } catch (err) {
      if (err instanceof CalendarProviderError && err.code === "CALENDAR_NOT_FOUND") return null;
      throw err;
    }
  }
}
