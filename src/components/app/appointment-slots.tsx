import { useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import { utcToLocalHHmm } from "@/lib/calendar/timezone";
import {
  getCalendarDayView,
  applyDailyOverride,
  removeDailyOverride,
  resolveSyncConflict,
} from "@/lib/calendar-dashboard.functions";
import { SectionCard, LoadingState, ErrorState } from "@/components/app/primitives";
import { describeQueryError } from "@/lib/query-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { cn } from "@/lib/utils";

/**
 * Date-wise appointment availability — lives below the weekly hours editor
 * in the Business page's Hours tab (there is deliberately no separate
 * Calendar/Availability page or tab: this used to be one, and keeping both
 * would mean two independent UIs editing the same business_hour_overrides
 * row, able to drift out of sync with each other). The slot grid and
 * override controls read from getCalendarDayView's single response so this
 * can never show a slot's state out of sync with what the voice agent and
 * booking backend would actually decide for that same slot — they all
 * resolve through the same resolveEffectiveOpenRangesUtc precedence logic
 * (calendar-service.server.ts), never a second, UI-only notion of "open".
 */

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysIso(dateIso: string, delta: number): string {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + delta));
  return next.toISOString().slice(0, 10);
}

type SlotState = "open" | "closed" | "booked" | "externally_busy";

const STATE_LABEL: Record<SlotState, string> = {
  open: "Open",
  closed: "Closed",
  booked: "Booked",
  externally_busy: "Externally busy",
};

const STATE_CLASS: Record<SlotState, string> = {
  open: "border-success/40 bg-success/10 text-success hover:bg-success/20",
  closed: "border-border bg-muted text-muted-foreground hover:bg-accent",
  booked: "border-primary/40 bg-primary/10 text-primary cursor-not-allowed",
  externally_busy: "border-warning/40 bg-warning/10 text-warning cursor-not-allowed",
};

function dayViewQuery(businessId: string, dateIso: string) {
  return queryOptions({
    queryKey: ["calendar-day-view", businessId, dateIso],
    queryFn: () => getCalendarDayView({ data: { businessId, dateIso } }),
  });
}

export function AppointmentSlotsSection({ businessId }: { businessId: string }) {
  const queryClient = useQueryClient();
  const [dateIso, setDateIso] = useState(todayIso());
  const {
    data: view,
    isLoading,
    isError: viewIsError,
    error: viewError,
    refetch: refetchView,
  } = useQuery(dayViewQuery(businessId, dateIso));

  const applyOverrideFn = useServerFn(applyDailyOverride);
  const removeOverrideFn = useServerFn(removeDailyOverride);
  const resolveConflictFn = useServerFn(resolveSyncConflict);

  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [closeDayReason, setCloseDayReason] = useState("");

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["calendar-day-view", businessId, dateIso] });
  }

  async function toggleSlot(startIso: string, endIso: string, currentState: SlotState) {
    if (!view) return;
    if (currentState === "booked" || currentState === "externally_busy") return;
    if (view.override?.isFullDayClosure) {
      toast.error(
        "This day is fully closed. Remove the full-day closure first to manage individual slots.",
      );
      return;
    }
    const timezone = view.business.timezone;
    const localStart = utcToLocalHHmm(new Date(startIso), timezone);
    const localEnd = utcToLocalHHmm(new Date(endIso), timezone);
    const wantsOpen = currentState !== "open";

    const existing = (view.override?.intervals ?? []) as {
      start: string;
      end: string;
      isOpen: boolean;
    }[];
    const merged = [
      ...existing.filter((i) => !(i.start === localStart && i.end === localEnd)),
      { start: localStart, end: localEnd, isOpen: wantsOpen },
    ];

    setSavingAction(`slot-${startIso}`);
    try {
      await applyOverrideFn({
        data: { businessId, dateIso, isFullDayClosure: false, intervals: merged },
      });
      toast.success(wantsOpen ? "Slot opened." : "Slot closed.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update that slot.");
    } finally {
      setSavingAction(null);
    }
  }

  async function closeEntireDay() {
    setSavingAction("close-day");
    try {
      await applyOverrideFn({
        data: {
          businessId,
          dateIso,
          isFullDayClosure: true,
          intervals: [],
          reason: closeDayReason || undefined,
        },
      });
      toast.success("Day closed.");
      setCloseDayReason("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not close this day.");
    } finally {
      setSavingAction(null);
    }
  }

  async function restoreNormalSchedule() {
    setSavingAction("restore");
    try {
      await removeOverrideFn({ data: { businessId, dateIso } });
      toast.success("Restored the normal weekly schedule for this date.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore the schedule.");
    } finally {
      setSavingAction(null);
    }
  }

  async function bulkToggle(target: "open" | "closed") {
    if (!view) return;
    if (view.override?.isFullDayClosure) {
      toast.error("Remove the full-day closure first.");
      return;
    }
    const timezone = view.business.timezone;
    const candidates = view.slots.filter((s) => s.state === target);
    if (candidates.length === 0) {
      toast.info(target === "open" ? "No closed slots to open." : "No open slots to close.");
      return;
    }
    const existing = (view.override?.intervals ?? []) as {
      start: string;
      end: string;
      isOpen: boolean;
    }[];
    const newEntries = candidates.map((s) => ({
      start: utcToLocalHHmm(new Date(s.startIso), timezone),
      end: utcToLocalHHmm(new Date(s.endIso), timezone),
      isOpen: target === "closed", // bulk-"open all closed slots" sets isOpen:true; bulk-"close all open slots" sets isOpen:false
    }));
    const newKeys = new Set(newEntries.map((e) => `${e.start}-${e.end}`));
    const merged = [...existing.filter((i) => !newKeys.has(`${i.start}-${i.end}`)), ...newEntries];

    setSavingAction(`bulk-${target}`);
    try {
      await applyOverrideFn({
        data: { businessId, dateIso, isFullDayClosure: false, intervals: merged },
      });
      toast.success(
        target === "open"
          ? `Opened ${candidates.length} slot(s).`
          : `Closed ${candidates.length} slot(s).`,
      );
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk action failed.");
    } finally {
      setSavingAction(null);
    }
  }

  async function handleResolveConflict(conflictId: string, status: "RESOLVED" | "DISMISSED") {
    setSavingAction(`conflict-${conflictId}`);
    try {
      await resolveConflictFn({ data: { conflictId, status } });
      toast.success(status === "RESOLVED" ? "Marked resolved." : "Dismissed.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update that conflict.");
    } finally {
      setSavingAction(null);
    }
  }

  const readOnly = view?.role === "viewer";

  return (
    <SectionCard
      title="Appointment Slots"
      description="Manage the exact appointment times customers can book through your AI receptionist."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setDateIso((d) => addDaysIso(d, -1))}>
            <ChevronLeft className="size-4" />
          </Button>
          <Input
            type="date"
            value={dateIso}
            onChange={(e) => setDateIso(e.target.value)}
            className="h-8 w-[150px]"
          />
          <Button variant="outline" size="sm" onClick={() => setDateIso((d) => addDaysIso(d, 1))}>
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDateIso(todayIso())}>
            Today
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <LoadingState label="Loading appointment slots" />
      ) : viewIsError ? (
        <ErrorState
          message={describeQueryError(viewError, "Could not load this day's appointment slots.")}
          onRetry={() => void refetchView()}
        />
      ) : !view ? (
        <LoadingState label="Loading appointment slots" />
      ) : (
        <div className="space-y-5">
          {view.scheduleConfigWarning ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {view.scheduleConfigWarning}
            </div>
          ) : null}

          {view.pendingSync ? (
            <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning">
              <RefreshCw className="size-3.5" />
              Pending synchronization — Google Calendar busy periods may not reflect the latest
              changes yet.
              {view.connectionError ? ` (${view.connectionError})` : ""}
            </div>
          ) : null}

          {view.openConflicts.length > 0 ? (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/8 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                <AlertTriangle className="size-3.5" />
                {view.openConflicts.length} sync conflict(s) need attention
              </p>
              {view.openConflicts.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
                >
                  <span>
                    {c.conflict_type === "EXTERNALLY_DELETED"
                      ? "A patient booking's Google Calendar event was deleted externally."
                      : "A patient booking's time was changed externally in Google Calendar."}
                  </span>
                  {!readOnly ? (
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingAction === `conflict-${c.id}`}
                        onClick={() => handleResolveConflict(c.id, "RESOLVED")}
                      >
                        Mark resolved
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={savingAction === `conflict-${c.id}`}
                        onClick={() => handleResolveConflict(c.id, "DISMISSED")}
                      >
                        Dismiss
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {view.override ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-foreground/20 bg-accent/40 px-3 py-2 text-xs">
              <span>
                {view.override.isFullDayClosure
                  ? `This date is fully closed${view.override.reason ? ` — ${view.override.reason}` : ""}.`
                  : "This date has a daily override applied."}
              </span>
              {!readOnly ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={savingAction === "restore"}
                  onClick={restoreNormalSchedule}
                >
                  {savingAction === "restore" ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : null}
                  Restore normal schedule
                </Button>
              ) : null}
            </div>
          ) : null}

          {!readOnly ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={savingAction === "bulk-closed"}
                onClick={() => bulkToggle("closed")}
              >
                Open all closed slots
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={savingAction === "bulk-open"}
                onClick={() => bulkToggle("open")}
              >
                Close all open slots
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={view.override?.isFullDayClosure}
                  >
                    Close entire day
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Close this entire day?</AlertDialogTitle>
                    <AlertDialogDescription>
                      No new appointments can be booked on {dateIso} while this closure is in
                      effect. Confirmed bookings already on the calendar are never cancelled by this
                      action.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="space-y-1.5">
                    <Label htmlFor="close-day-reason">Reason (optional)</Label>
                    <Input
                      id="close-day-reason"
                      value={closeDayReason}
                      onChange={(e) => setCloseDayReason(e.target.value)}
                      placeholder="Public holiday"
                    />
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={closeEntireDay}>Close day</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {view.slots.map((slot) => {
              const localLabel = utcToLocalHHmm(new Date(slot.startIso), view.business.timezone);
              const state = slot.state as SlotState;
              const disabled =
                readOnly ||
                state === "booked" ||
                state === "externally_busy" ||
                savingAction === `slot-${slot.startIso}`;
              return (
                <button
                  key={slot.startIso}
                  disabled={disabled}
                  onClick={() => toggleSlot(slot.startIso, slot.endIso, state)}
                  title={STATE_LABEL[state]}
                  className={cn(
                    "rounded-md border px-2 py-2 text-left text-[11px] font-medium transition-colors",
                    STATE_CLASS[state],
                    disabled && state !== "booked" && state !== "externally_busy" && "opacity-60",
                  )}
                >
                  <div className="tabular">{localLabel}</div>
                  <div className="mt-0.5 text-[10px] opacity-80">{STATE_LABEL[state]}</div>
                </button>
              );
            })}
          </div>

          {view.slots.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No appointment slots for this date — it's closed under the weekly schedule and has no
              exceptional-availability override.
            </p>
          ) : null}

          {view.confirmedBookings.length > 0 ? (
            <div className="space-y-1.5 border-t border-border pt-4">
              <p className="text-xs font-semibold text-muted-foreground">Confirmed appointments</p>
              {view.confirmedBookings.map((b) => (
                <div key={b.id} className="flex items-center justify-between text-xs">
                  <span>{b.customer_name ?? "Unnamed customer"}</span>
                  <span className="text-muted-foreground">
                    {utcToLocalHHmm(new Date(b.start_at), view.business.timezone)} –{" "}
                    {utcToLocalHHmm(new Date(b.end_at), view.business.timezone)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
