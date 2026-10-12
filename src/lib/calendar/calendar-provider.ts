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
  | "EVENT_NOT_FOUND"
  // Incremental-sync specific (events.list with an expired syncToken, HTTP
  // 410) — the provider's documented signal to discard the stored token and
  // perform a fresh full resync, not a generic failure. Not used by the
  // booking path (createEvent/getBusyPeriods/etc.) at all, only by the
  // Google Calendar sync service (google-calendar-sync.server.ts).
  | "SYNC_TOKEN_EXPIRED";

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
  /**
   * ClickAI booking this event represents. Stored as a private extended
   * property (visible only to this OAuth client, never to attendees) so a
   * retry can find an event an earlier, partially failed attempt already
   * created instead of inserting a duplicate.
   */
  clickaiBookingId?: string | undefined;
}

export interface NormalizedCalendarEvent {
  id: string;
  title: string;
  description: string | undefined;
  start: string;
  end: string;
  status: "confirmed" | "cancelled" | "tentative";
  /** The ClickAI booking id tag, when the event carries one (see CalendarEventInput.clickaiBookingId). */
  clickaiBookingId?: string | undefined;
}

export interface CalendarListEntry {
  id: string;
  name: string;
  primary: boolean;
  /** Google's calendarList accessRole: "owner" | "writer" | "reader" | "freeBusyReader". */
  accessRole?: string | undefined;
}

/** Only calendars ClickAI can create events in may be selected for bookings. */
export function calendarAllowsWrites(entry: Pick<CalendarListEntry, "accessRole">): boolean {
  return entry.accessRole === "owner" || entry.accessRole === "writer";
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
  /** Finds a live event this client tagged with the given booking id, if any. */
  findEventByBookingId?(
    calendarId: string,
    bookingId: string,
  ): Promise<NormalizedCalendarEvent | null>;
}
