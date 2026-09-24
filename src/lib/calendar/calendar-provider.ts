/**
 * Provider-independent calendar abstraction (spec section 13: "AI Agent ->
 * Calendar Tool -> Calendar Service -> Google Calendar Provider... do not
 * hard-code Google-specific logic into AI agent code"). GoogleCalendarProvider
 * (google-calendar-provider.server.ts) is the only implementation today;
 * a future Microsoft/Apple/other provider implements the same interface
 * without calendar-service.server.ts or calendar-tools.server.ts changing.
 */

export type CalendarProviderErrorCode =
  | "GOOGLE_AUTH_REQUIRED"
  | "CALENDAR_NOT_FOUND"
  | "CALENDAR_ACCESS_DENIED"
  | "CALENDAR_RATE_LIMITED"
  | "CALENDAR_CONFLICT"
  | "CALENDAR_UNAVAILABLE"
  | "EVENT_NOT_FOUND";

/** Safe-to-surface, provider-agnostic error — callers never see a raw Google error (spec section 35: "never show raw provider errors to customers"). */
export class CalendarProviderError extends Error {
  code: CalendarProviderErrorCode;
  /** Whether a caller may safely retry this exact operation (transient network/5xx/429 — never for auth/permission/not-found). */
  retryable: boolean;
  constructor(code: CalendarProviderErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface CalendarBusyPeriod {
  start: string; // ISO 8601
  end: string; // ISO 8601
}

export interface GetBusyPeriodsInput {
  calendarId: string;
  timeMinIso: string;
  timeMaxIso: string;
}

export interface CalendarEventInput {
  calendarId: string;
  title: string;
  description?: string | undefined;
  startIso: string;
  endIso: string;
  timezone: string;
}

export interface NormalizedCalendarEvent {
  id: string;
  title: string;
  description: string | undefined;
  start: string;
  end: string;
  status: "confirmed" | "cancelled" | "tentative";
}

export interface CalendarListEntry {
  id: string;
  name: string;
  primary: boolean;
}

export interface CalendarProvider {
  listCalendars(): Promise<CalendarListEntry[]>;
  getBusyPeriods(input: GetBusyPeriodsInput): Promise<CalendarBusyPeriod[]>;
  createEvent(input: CalendarEventInput): Promise<NormalizedCalendarEvent>;
  updateEvent(
    calendarId: string,
    eventId: string,
    input: Partial<CalendarEventInput>,
  ): Promise<NormalizedCalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  getEvent(calendarId: string, eventId: string): Promise<NormalizedCalendarEvent | null>;
}
