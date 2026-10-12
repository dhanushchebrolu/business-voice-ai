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
import { describeGoogleCalendarCardState } from "./google-calendar-card-state";

/**
 * Google Calendar integration card — one per business, matching the exact
 * copy blocks and connect-style UX from spec sections 5/41/72 ("Connect
 * Google Calendar", never "enter your API key"). Purely presentational:
 * all data and mutations are owned by the parent route (app.integrations.
 * tsx), matching this codebase's established WhatsApp connection-card
 * pattern.
 *
 * States (describeGoogleCalendarCardState): disconnected, choose_calendar,
 * connected, reauth_required, sync_error. Management actions render only
 * for owners/admins (`canManage`); the server enforces the same rule on
 * every action regardless of what the UI shows.
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

function CalendarPicker({
  options,
  name,
  selecting,
  onSave,
  saveLabel,
}: {
  options: GoogleCalendarOption[];
  name: string;
  selecting: boolean;
  onSave: (calendarId: string) => void;
  saveLabel: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  if (options.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        This Google account has no calendars ClickAI can add events to. Ask the calendar owner to
        give this account “Make changes to events” access, or connect a different account.
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-1.5">
      {options.map((cal) => (
        <label
          key={cal.id}
          className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/50"
        >
          <input
            type="radio"
            name={name}
            value={cal.id}
            checked={picked === cal.id}
            onChange={() => setPicked(cal.id)}
          />
          {cal.name}
          {cal.primary ? <span className="text-xs text-muted-foreground">(primary)</span> : null}
        </label>
      ))}
      <Button
        className="mt-2"
        size="sm"
        disabled={!picked || selecting}
        onClick={() => picked && onSave(picked)}
      >
        {selecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
        {saveLabel}
      </Button>
    </div>
  );
}

export function GoogleCalendarCard({
  businessName,
  connection,
  canManage,
  syncFailedCount,
  connecting,
  onConnect,
  loadingCalendars,
  calendarOptions,
  onLoadCalendars,
  selecting,
  onSelectCalendar,
  disconnecting,
  onDisconnect,
  testing,
  onTest,
}: {
  businessName: string;
  connection: GoogleCalendarConnectionSummary | null;
  canManage: boolean;
  syncFailedCount: number;
  connecting: boolean;
  onConnect: () => void;
  loadingCalendars: boolean;
  calendarOptions: GoogleCalendarOption[] | null;
  onLoadCalendars: () => void;
  selecting: boolean;
  onSelectCalendar: (calendarId: string) => void;
  disconnecting: boolean;
  onDisconnect: () => void;
  testing: boolean;
  onTest: () => void;
}) {
  const state = describeGoogleCalendarCardState(connection, { syncFailedCount });
  const hasCalendar = Boolean(connection?.calendar_id);

  const disconnectButton = connection ? (
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
            ClickAI will stop checking availability or creating events for {businessName}, and its
            access to this Google account will be revoked. Your Google Calendar itself, its events,
            and ClickAI's past bookings are not affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onDisconnect}>Disconnect</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  const testButton = (
    <Button variant="outline" size="sm" onClick={onTest} disabled={testing}>
      {testing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
      Test connection
    </Button>
  );

  const loadCalendarsButton = (label: string) => (
    <Button variant="outline" size="sm" onClick={onLoadCalendars} disabled={loadingCalendars}>
      {loadingCalendars ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
      {label}
    </Button>
  );

  return (
    <div className="panel p-5" data-state={state.kind}>
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
        <StatusPill tone={state.pill.tone}>{state.pill.label}</StatusPill>
      </div>

      {state.kind === "disconnected" && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Connect your business calendar to allow ClickAI to check availability and automatically
            schedule appointments.
          </p>
          {canManage ? (
            <Button className="mt-4" onClick={onConnect} disabled={connecting}>
              {connecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Connect Google Calendar
            </Button>
          ) : null}
        </div>
      )}

      {(state.kind === "reauth_required" || state.kind === "sync_error") && state.message && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{state.message}</p>
        </div>
      )}

      {state.kind === "choose_calendar" && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">{state.message}</p>
          {canManage &&
            (calendarOptions === null ? (
              <div className="mt-3">{loadCalendarsButton("Load calendars")}</div>
            ) : (
              <CalendarPicker
                options={calendarOptions}
                name="calendar"
                selecting={selecting}
                onSave={onSelectCalendar}
                saveLabel="Save calendar"
              />
            ))}
        </div>
      )}

      {connection && state.kind !== "disconnected" && (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Account</dt>
          <dd className="break-all">{connection.google_email ?? "Google account"}</dd>
          {hasCalendar ? (
            <>
              <dt className="text-muted-foreground">Calendar</dt>
              <dd>{connection.calendar_name ?? "—"}</dd>
            </>
          ) : null}
        </dl>
      )}

      {state.kind === "connected" && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="size-4" /> Connected
          </div>
          <ul className="grid grid-cols-2 gap-1 text-xs text-muted-foreground sm:grid-cols-3">
            <li>✓ Check availability</li>
            <li>✓ Book appointments</li>
            <li>✓ Reschedule</li>
            <li>✓ Cancel appointments</li>
            <li>✓ Keep calendars updated</li>
          </ul>
        </div>
      )}

      {canManage && connection && state.kind !== "disconnected" && (
        <div className="mt-4 flex flex-wrap gap-2">
          {hasCalendar && state.kind !== "reauth_required" ? testButton : null}
          {hasCalendar && state.kind !== "reauth_required"
            ? loadCalendarsButton("Change calendar")
            : null}
          {state.kind === "reauth_required" || state.kind === "sync_error" ? (
            <Button size="sm" onClick={onConnect} disabled={connecting}>
              {connecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Reconnect
            </Button>
          ) : null}
          {disconnectButton}
        </div>
      )}

      {canManage && hasCalendar && state.kind !== "choose_calendar" && calendarOptions !== null && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">Choose a different calendar:</p>
          <CalendarPicker
            options={calendarOptions}
            name="calendar-change"
            selecting={selecting}
            onSave={onSelectCalendar}
            saveLabel="Save"
          />
        </div>
      )}

      {!canManage && state.kind !== "connected" && (
        <p className="mt-4 text-xs text-muted-foreground">
          Only workspace owners and admins can change this connection.
        </p>
      )}
    </div>
  );
}
