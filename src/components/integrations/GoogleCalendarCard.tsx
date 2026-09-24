import { useState } from "react";
import { Loader2, Calendar, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { StatusPill } from "@/components/app/primitives";

/**
 * Google Calendar integration card — one per business, matching the exact
 * copy blocks and connect-style UX from spec sections 5/41/72 ("Connect
 * Google Calendar", never "enter your API key"). Purely presentational:
 * all data and mutations are owned by the parent route (app.integrations.
 * tsx), matching this codebase's established WhatsApp connection-card
 * pattern.
 */

export interface GoogleCalendarConnectionSummary {
  id: string;
  business_id: string | null;
  google_email: string | null;
  calendar_id: string | null;
  calendar_name: string | null;
  status: string;
  last_error: string | null;
}

export interface GoogleCalendarOption {
  id: string;
  name: string;
  primary: boolean;
}

export function GoogleCalendarCard({
  businessName,
  connection,
  connecting,
  onConnect,
  loadingCalendars,
  calendarOptions,
  onLoadCalendars,
  selecting,
  onSelectCalendar,
  disconnecting,
  onDisconnect,
}: {
  businessName: string;
  connection: GoogleCalendarConnectionSummary | null;
  connecting: boolean;
  onConnect: () => void;
  loadingCalendars: boolean;
  calendarOptions: GoogleCalendarOption[] | null;
  onLoadCalendars: () => void;
  selecting: boolean;
  onSelectCalendar: (calendarId: string, calendarName: string) => void;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  const [pickedCalendarId, setPickedCalendarId] = useState<string | null>(null);

  const status = connection?.status ?? "DISCONNECTED";

  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-muted">
            <Calendar className="size-4 text-muted-foreground" />
          </span>
          <div>
            <p className="text-sm font-semibold">Google Calendar</p>
            <p className="text-xs text-muted-foreground">{businessName}</p>
          </div>
        </div>
        {status === "CONNECTED" ? (
          <StatusPill tone="live">Connected</StatusPill>
        ) : status === "NEEDS_CALENDAR_SELECTION" ? (
          <StatusPill tone="ready">Choose a calendar</StatusPill>
        ) : status === "NEEDS_REAUTH" || status === "ERROR" ? (
          <StatusPill tone="error">Needs attention</StatusPill>
        ) : (
          <StatusPill tone="idle">Not connected</StatusPill>
        )}
      </div>

      {status === "DISCONNECTED" && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Connect your business calendar to allow ClickAI to check availability and automatically
            schedule appointments.
          </p>
          <Button className="mt-4" onClick={onConnect} disabled={connecting}>
            {connecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Connect Google Calendar
          </Button>
        </div>
      )}

      {(status === "NEEDS_REAUTH" || status === "ERROR") && (
        <div className="mt-4">
          <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">
              Your Google Calendar connection needs to be re-authorized.
              {connection?.last_error ? ` (${connection.last_error})` : ""}
            </p>
          </div>
          <Button className="mt-4" onClick={onConnect} disabled={connecting}>
            {connecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Reconnect
          </Button>
        </div>
      )}

      {status === "NEEDS_CALENDAR_SELECTION" && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Choose the calendar ClickAI should use for this business's appointments.
          </p>
          {calendarOptions === null ? (
            <Button
              className="mt-3"
              variant="outline"
              onClick={onLoadCalendars}
              disabled={loadingCalendars}
            >
              {loadingCalendars ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Load calendars
            </Button>
          ) : calendarOptions.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No calendars found on this Google account.
            </p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {calendarOptions.map((cal) => (
                <label
                  key={cal.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <input
                    type="radio"
                    name="calendar"
                    value={cal.id}
                    checked={pickedCalendarId === cal.id}
                    onChange={() => setPickedCalendarId(cal.id)}
                  />
                  {cal.name}
                  {cal.primary ? (
                    <span className="text-xs text-muted-foreground">(primary)</span>
                  ) : null}
                </label>
              ))}
              <Button
                className="mt-2"
                disabled={!pickedCalendarId || selecting}
                onClick={() => {
                  const picked = calendarOptions.find((c) => c.id === pickedCalendarId);
                  if (picked) onSelectCalendar(picked.id, picked.name);
                }}
              >
                {selecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
                Save calendar
              </Button>
            </div>
          )}
        </div>
      )}

      {status === "CONNECTED" && connection && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="size-4" /> Connected
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Account</dt>
            <dd>{connection.google_email ?? "—"}</dd>
            <dt className="text-muted-foreground">Calendar</dt>
            <dd>{connection.calendar_name ?? "—"}</dd>
          </dl>
          <ul className="grid grid-cols-2 gap-1 text-xs text-muted-foreground sm:grid-cols-3">
            <li>✓ Check availability</li>
            <li>✓ Book appointments</li>
            <li>✓ Reschedule</li>
            <li>✓ Cancel appointments</li>
            <li>✓ Keep calendars updated</li>
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={onLoadCalendars}
              disabled={loadingCalendars}
            >
              {loadingCalendars ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Change Calendar
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={disconnecting}>
                  {disconnecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
                  Disconnect
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect Google Calendar?</AlertDialogTitle>
                  <AlertDialogDescription>
                    ClickAI will stop checking availability or creating events for {businessName}.
                    Your Google Calendar itself, its events, and ClickAI's past bookings are not
                    affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDisconnect}>Disconnect</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          {calendarOptions !== null && calendarOptions.length > 0 && (
            <div className="mt-2 space-y-1.5 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">Choose a different calendar:</p>
              {calendarOptions.map((cal) => (
                <label
                  key={cal.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <input
                    type="radio"
                    name="calendar-change"
                    value={cal.id}
                    checked={pickedCalendarId === cal.id}
                    onChange={() => setPickedCalendarId(cal.id)}
                  />
                  {cal.name}
                </label>
              ))}
              <Button
                size="sm"
                disabled={!pickedCalendarId || selecting}
                onClick={() => {
                  const picked = calendarOptions.find((c) => c.id === pickedCalendarId);
                  if (picked) onSelectCalendar(picked.id, picked.name);
                }}
              >
                {selecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
                Save
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
