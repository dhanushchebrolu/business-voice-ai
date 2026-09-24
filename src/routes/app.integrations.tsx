import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { PageHeader, LoadingState, EmptyState } from "@/components/app/primitives";
import {
  GoogleCalendarCard,
  type GoogleCalendarOption,
} from "@/components/integrations/GoogleCalendarCard";
import {
  listGoogleCalendarConnections,
  listOrgBusinessesForCalendar,
  connectGoogleCalendar,
  listGoogleCalendars,
  selectGoogleCalendar,
  disconnectGoogleCalendar,
} from "@/lib/google-calendar.functions";

const searchSchema = z.object({
  google_calendar: z.enum(["connected", "error"]).optional(),
  reason: z.string().optional(),
  connection_id: z.string().optional(),
});

export const Route = createFileRoute("/app/integrations")({
  head: () => ({
    meta: [
      { title: "Integrations — ClickAI" },
      { name: "description", content: "Connect Google Calendar and other business tools." },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: searchSchema,
  component: IntegrationsPage,
});

const businessesQuery = queryOptions({
  queryKey: ["calendar-businesses"],
  queryFn: () => listOrgBusinessesForCalendar(),
});

const connectionsQuery = queryOptions({
  queryKey: ["google-calendar-connections"],
  queryFn: () => listGoogleCalendarConnections(),
});

function IntegrationsPage() {
  const search = useSearch({ from: "/app/integrations" });
  const queryClient = useQueryClient();

  const connectFn = useServerFn(connectGoogleCalendar);
  const listCalendarsFn = useServerFn(listGoogleCalendars);
  const selectCalendarFn = useServerFn(selectGoogleCalendar);
  const disconnectFn = useServerFn(disconnectGoogleCalendar);

  const businessesRes = useQuery(businessesQuery);
  const connectionsRes = useQuery(connectionsQuery);

  const [connectingBusinessId, setConnectingBusinessId] = useState<string | null>(null);
  const [loadingCalendarsFor, setLoadingCalendarsFor] = useState<string | null>(null);
  const [calendarOptionsByConnection, setCalendarOptionsByConnection] = useState<
    Record<string, GoogleCalendarOption[]>
  >({});
  const [selectingFor, setSelectingFor] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  useEffect(() => {
    if (search.google_calendar === "connected") {
      toast.success("Google Calendar connected. Choose which calendar to use below.");
      void queryClient.invalidateQueries({ queryKey: ["google-calendar-connections"] });
    } else if (search.google_calendar === "error") {
      const reason = search.reason ?? "unknown_error";
      toast.error(
        reason === "denied"
          ? "Google Calendar connection was cancelled."
          : "Couldn't connect Google Calendar. Please try again.",
      );
    }
    // Intentionally only reacts to the query params present on the initial
    // landing from the OAuth redirect, not on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect(businessId: string) {
    setConnectingBusinessId(businessId);
    try {
      const result = await connectFn({ data: { businessId } });
      window.location.href = result.authorizationUrl;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't start the Google Calendar connection.",
      );
      setConnectingBusinessId(null);
    }
  }

  async function handleLoadCalendars(connectionId: string) {
    setLoadingCalendarsFor(connectionId);
    try {
      const calendars = await listCalendarsFn({ data: { connectionId } });
      setCalendarOptionsByConnection((prev) => ({ ...prev, [connectionId]: calendars }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load calendars from Google.");
    } finally {
      setLoadingCalendarsFor(null);
    }
  }

  async function handleSelectCalendar(
    connectionId: string,
    calendarId: string,
    calendarName: string,
  ) {
    setSelectingFor(connectionId);
    try {
      await selectCalendarFn({ data: { connectionId, calendarId, calendarName } });
      toast.success(`Using "${calendarName}" for this business.`);
      setCalendarOptionsByConnection((prev) => {
        const next = { ...prev };
        delete next[connectionId];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["google-calendar-connections"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that calendar.");
    } finally {
      setSelectingFor(null);
    }
  }

  async function handleDisconnect(connectionId: string) {
    setDisconnectingId(connectionId);
    try {
      await disconnectFn({ data: { connectionId } });
      toast.success("Google Calendar disconnected.");
      await queryClient.invalidateQueries({ queryKey: ["google-calendar-connections"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect Google Calendar.");
    } finally {
      setDisconnectingId(null);
    }
  }

  const loading = businessesRes.isLoading || connectionsRes.isLoading;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect the tools your AI agents use to get real work done."
      />

      {loading ? (
        <LoadingState label="Loading integrations" />
      ) : !businessesRes.data || businessesRes.data.length === 0 ? (
        <EmptyState
          title="No businesses yet"
          description="Add a business before connecting Google Calendar."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {businessesRes.data.map((business) => {
            const connection =
              (connectionsRes.data ?? []).find((c) => c.business_id === business.id) ?? null;
            return (
              <GoogleCalendarCard
                key={business.id}
                businessName={business.name}
                connection={connection}
                connecting={connectingBusinessId === business.id}
                onConnect={() => handleConnect(business.id)}
                loadingCalendars={loadingCalendarsFor === connection?.id}
                calendarOptions={
                  connection ? (calendarOptionsByConnection[connection.id] ?? null) : null
                }
                onLoadCalendars={() => connection && handleLoadCalendars(connection.id)}
                selecting={selectingFor === connection?.id}
                onSelectCalendar={(calendarId, calendarName) =>
                  connection && handleSelectCalendar(connection.id, calendarId, calendarName)
                }
                disconnecting={disconnectingId === connection?.id}
                onDisconnect={() => connection && handleDisconnect(connection.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
