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
} from "@/components/app/primitives";
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
import { listBookings, cancelBookingManual } from "@/lib/bookings.functions";

/**
 * Minimal, extensible upcoming-appointments list (spec section 42: "don't
 * build a huge booking management system in this phase, keep it
 * extensible"). Reschedule is intentionally not wired to a UI flow yet —
 * cancellation is the one destructive action worth a confirmation dialog
 * here; a full reschedule picker belongs with the availability UI in a
 * later phase.
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

function BookingsPage() {
  const queryClient = useQueryClient();
  const cancelFn = useServerFn(cancelBookingManual);
  const { data: bookings, isLoading } = useQuery(bookingsQuery);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

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

  return (
    <div className="space-y-6">
      <PageHeader title="Bookings" description="Appointments your AI agents have booked." />

      {isLoading ? (
        <LoadingState label="Loading bookings" />
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
