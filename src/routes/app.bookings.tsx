import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatusPill,
  LoadingState,
  EmptyState,
  ErrorState,
} from "@/components/app/primitives";
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
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  listBookings,
  cancelBookingManual,
  rescheduleBookingManual,
} from "@/lib/bookings.functions";

/**
 * Minimal, extensible upcoming-appointments list (spec section 42: "don't
 * build a huge booking management system in this phase, keep it
 * extensible"). Reschedule uses the existing rescheduleBookingManual server
 * function (bookings.functions.ts) — it already re-checks for conflicts
 * and updates the real Google Calendar event via booking-service.server.ts;
 * this page only needed the UI to actually call it. The new start time
 * keeps the booking's original duration (end - start), so the picker only
 * needs a single start-time input.
 */

export const Route = createFileRoute("/app/bookings")({
  head: () => ({
    meta: [
      { title: "Bookings — ClickAI" },
      { name: "description", content: "Appointments your AI agents have booked." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: BookingsPage,
});

const bookingsQuery = queryOptions({
  queryKey: ["bookings"],
  queryFn: () => listBookings(),
});

const STATUS_TONE: Record<string, "live" | "ready" | "idle" | "error"> = {
  CONFIRMED: "live",
  RESCHEDULED: "live",
  PENDING_CONFIRMATION: "ready",
  DRAFT: "idle",
  COMPLETED: "idle",
  CANCELLED: "idle",
  NO_SHOW: "error",
  CALENDAR_SYNC_FAILED: "error",
};

function formatDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  };
}

/** For the <input type="datetime-local"> value — local wall-clock time, no timezone suffix. */
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function BookingsPage() {
  const queryClient = useQueryClient();
  const cancelFn = useServerFn(cancelBookingManual);
  const rescheduleFn = useServerFn(rescheduleBookingManual);
  const { data: bookings, isLoading, isError, error, refetch } = useQuery(bookingsQuery);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [newStartLocal, setNewStartLocal] = useState("");

  async function handleCancel(bookingId: string) {
    setCancellingId(bookingId);
    try {
      await cancelFn({ data: { bookingId } });
      toast.success("Booking cancelled.");
      await queryClient.invalidateQueries({ queryKey: ["bookings"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't cancel that booking.");
    } finally {
      setCancellingId(null);
    }
  }

  async function handleReschedule(
    bookingId: string,
    currentStartIso: string,
    currentEndIso: string,
  ) {
    if (!newStartLocal) return;
    const newStart = new Date(newStartLocal);
    if (Number.isNaN(newStart.getTime())) {
      toast.error("Enter a valid date and time.");
      return;
    }
    // Keeps the booking's original duration — the picker only asks for a
    // new start time, not a new duration.
    const durationMs = new Date(currentEndIso).getTime() - new Date(currentStartIso).getTime();
    const newEnd = new Date(newStart.getTime() + durationMs);

    setReschedulingId(bookingId);
    try {
      await rescheduleFn({
        data: {
          bookingId,
          newStartIso: newStart.toISOString(),
          newEndIso: newEnd.toISOString(),
        },
      });
      toast.success("Booking rescheduled.");
      await queryClient.invalidateQueries({ queryKey: ["bookings"] });
      setNewStartLocal("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't reschedule that booking.");
    } finally {
      setReschedulingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Bookings" description="Appointments your AI agents have booked." />

      {isLoading ? (
        <LoadingState label="Loading bookings" />
      ) : isError ? (
        <ErrorState
          message={describeQueryError(error, "Could not load your bookings.")}
          onRetry={() => void refetch()}
        />
      ) : !bookings || bookings.length === 0 ? (
        <EmptyState
          title="No bookings yet"
          description="Once your AI agent books an appointment, it will show up here."
        />
      ) : (
        <SectionCard title="Upcoming and recent" description={`${bookings.length} booking(s)`}>
          <div className="divide-y divide-border">
            {bookings.map((booking) => {
              const { date, time } = formatDateTime(booking.start_at);
              const cancellable = booking.status !== "CANCELLED" && booking.status !== "COMPLETED";
              return (
                <div
                  key={booking.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {booking.customer_name ?? "Unnamed customer"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {date} · {time} · {booking.timezone}
                      {booking.customer_phone ? ` · ${booking.customer_phone}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill tone={STATUS_TONE[booking.status] ?? "idle"}>
                      {booking.status.replace(/_/g, " ")}
                    </StatusPill>
                    {cancellable && (
                      <Dialog
                        onOpenChange={(open) => {
                          if (open) setNewStartLocal(toDatetimeLocalValue(booking.start_at));
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={reschedulingId === booking.id}
                          >
                            {reschedulingId === booking.id ? (
                              <Loader2 className="mr-1.5 size-4 animate-spin" />
                            ) : null}
                            Reschedule
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Reschedule this booking?</DialogTitle>
                            <DialogDescription>
                              Picks a new start time and keeps the same appointment length. This
                              re-checks for conflicts and updates the connected Google Calendar
                              event.
                            </DialogDescription>
                          </DialogHeader>
                          <div className="space-y-2">
                            <Label htmlFor={`reschedule-${booking.id}`}>New start time</Label>
                            <Input
                              id={`reschedule-${booking.id}`}
                              type="datetime-local"
                              value={newStartLocal}
                              onChange={(e) => setNewStartLocal(e.target.value)}
                            />
                          </div>
                          <DialogFooter>
                            <Button
                              onClick={() =>
                                handleReschedule(booking.id, booking.start_at, booking.end_at)
                              }
                              disabled={reschedulingId === booking.id}
                            >
                              {reschedulingId === booking.id ? (
                                <Loader2 className="mr-1.5 size-4 animate-spin" />
                              ) : null}
                              Confirm new time
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    )}
                    {cancellable && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={cancellingId === booking.id}
                          >
                            {cancellingId === booking.id ? (
                              <Loader2 className="mr-1.5 size-4 animate-spin" />
                            ) : null}
                            Cancel
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Cancel this booking?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the appointment from the connected Google Calendar and
                              marks it cancelled in ClickAI. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep booking</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleCancel(booking.id)}>
                              Cancel booking
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
