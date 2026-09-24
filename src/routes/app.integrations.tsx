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
import { RazorpayCard } from "@/components/integrations/RazorpayCard";
import { InstagramCard } from "@/components/integrations/InstagramCard";
import {
  InstagramAutomationRules,
  type InstagramAutomationRuleSummary,
} from "@/components/integrations/InstagramAutomationRules";
import {
  listGoogleCalendarConnections,
  listOrgBusinessesForCalendar,
  connectGoogleCalendar,
  listGoogleCalendars,
  selectGoogleCalendar,
  disconnectGoogleCalendar,
} from "@/lib/google-calendar.functions";
import {
  listRazorpayConnections,
  getRazorpayIntegrationStatus,
  startRazorpayConnection,
  reconnectRazorpayConnection,
  verifyRazorpayConnection,
  disconnectRazorpayConnection,
} from "@/lib/razorpay.functions";
import {
  listInstagramConnections,
  listOrgBusinessesForInstagram,
  getInstagramIntegrationStatus,
  startInstagramConnection,
  assignInstagramBot,
  disconnectInstagramConnection,
  listInstagramAutomationRules,
  upsertInstagramAutomationRule,
  toggleInstagramAutomationRule,
  deleteInstagramAutomationRule,
} from "@/lib/instagram.functions";

const searchSchema = z.object({
  google_calendar: z.enum(["connected", "error"]).optional(),
  razorpay: z.enum(["connected", "error"]).optional(),
  instagram: z.enum(["connected", "error"]).optional(),
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

const razorpayConnectionsQuery = queryOptions({
  queryKey: ["razorpay-connections"],
  queryFn: () => listRazorpayConnections(),
});

const razorpayStatusQuery = queryOptions({
  queryKey: ["razorpay-integration-status"],
  queryFn: () => getRazorpayIntegrationStatus(),
});

const instagramBusinessesQuery = queryOptions({
  queryKey: ["instagram-businesses"],
  queryFn: () => listOrgBusinessesForInstagram(),
});

const instagramConnectionsQuery = queryOptions({
  queryKey: ["instagram-connections"],
  queryFn: () => listInstagramConnections(),
});

const instagramStatusQuery = queryOptions({
  queryKey: ["instagram-integration-status"],
  queryFn: () => getInstagramIntegrationStatus(),
});

const instagramAutomationRulesQuery = queryOptions({
  queryKey: ["instagram-automation-rules"],
  queryFn: () => listInstagramAutomationRules(),
});

function IntegrationsPage() {
  const search = useSearch({ from: "/app/integrations" });
  const queryClient = useQueryClient();

  const connectFn = useServerFn(connectGoogleCalendar);
  const listCalendarsFn = useServerFn(listGoogleCalendars);
  const selectCalendarFn = useServerFn(selectGoogleCalendar);
  const disconnectFn = useServerFn(disconnectGoogleCalendar);

  const startRazorpayFn = useServerFn(startRazorpayConnection);
  const reconnectRazorpayFn = useServerFn(reconnectRazorpayConnection);
  const verifyRazorpayFn = useServerFn(verifyRazorpayConnection);
  const disconnectRazorpayFn = useServerFn(disconnectRazorpayConnection);

  const startInstagramFn = useServerFn(startInstagramConnection);
  const assignInstagramBotFn = useServerFn(assignInstagramBot);
  const disconnectInstagramFn = useServerFn(disconnectInstagramConnection);
  const upsertInstagramRuleFn = useServerFn(upsertInstagramAutomationRule);
  const toggleInstagramRuleFn = useServerFn(toggleInstagramAutomationRule);
  const deleteInstagramRuleFn = useServerFn(deleteInstagramAutomationRule);

  const businessesRes = useQuery(businessesQuery);
  const connectionsRes = useQuery(connectionsQuery);
  const razorpayConnectionsRes = useQuery(razorpayConnectionsQuery);
  const razorpayStatusRes = useQuery(razorpayStatusQuery);
  const instagramBusinessesRes = useQuery(instagramBusinessesQuery);
  const instagramConnectionsRes = useQuery(instagramConnectionsQuery);
  const instagramStatusRes = useQuery(instagramStatusQuery);
  const instagramAutomationRulesRes = useQuery(instagramAutomationRulesQuery);

  const [connectingBusinessId, setConnectingBusinessId] = useState<string | null>(null);
  const [loadingCalendarsFor, setLoadingCalendarsFor] = useState<string | null>(null);
  const [calendarOptionsByConnection, setCalendarOptionsByConnection] = useState<
    Record<string, GoogleCalendarOption[]>
  >({});
  const [selectingFor, setSelectingFor] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  const [connectingRazorpayFor, setConnectingRazorpayFor] = useState<string | null>(null);
  const [reconnectingRazorpayId, setReconnectingRazorpayId] = useState<string | null>(null);
  const [verifyingRazorpayId, setVerifyingRazorpayId] = useState<string | null>(null);
  const [disconnectingRazorpayId, setDisconnectingRazorpayId] = useState<string | null>(null);

  const [connectingInstagram, setConnectingInstagram] = useState(false);
  const [assigningInstagramId, setAssigningInstagramId] = useState<string | null>(null);
  const [disconnectingInstagramId, setDisconnectingInstagramId] = useState<string | null>(null);
  const [savingInstagramRule, setSavingInstagramRule] = useState(false);
  const [deletingInstagramRuleId, setDeletingInstagramRuleId] = useState<string | null>(null);

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
    if (search.razorpay === "connected") {
      toast.success("Razorpay connected.");
      void queryClient.invalidateQueries({ queryKey: ["razorpay-connections"] });
    } else if (search.razorpay === "error") {
      const reason = search.reason ?? "unknown_error";
      toast.error(
        reason === "denied"
          ? "Razorpay connection was cancelled."
          : "Couldn't connect Razorpay. Please try again.",
      );
    }
    if (search.instagram === "connected") {
      toast.success(
        search.reason === "needs_attention"
          ? "Instagram connected, but needs attention — see the connection below."
          : "Instagram connected.",
      );
      void queryClient.invalidateQueries({ queryKey: ["instagram-connections"] });
    } else if (search.instagram === "error") {
      const reason = search.reason ?? "unknown_error";
      toast.error(
        reason === "denied"
          ? "Instagram connection was cancelled."
          : reason === "no_instagram_account"
            ? "No Instagram professional account is linked to the Facebook Page(s) you granted access to."
            : reason === "ambiguous_account"
              ? "You granted access to more than one Instagram account. Please reconnect and grant access to only one."
              : "Couldn't connect Instagram. Please try again.",
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

  async function handleConnectRazorpay(businessId: string) {
    setConnectingRazorpayFor(businessId);
    try {
      const result = await startRazorpayFn({ data: { businessId } });
      window.location.href = result.authorizationUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the Razorpay connection.");
      setConnectingRazorpayFor(null);
    }
  }

  async function handleReconnectRazorpay(connectionId: string) {
    setReconnectingRazorpayId(connectionId);
    try {
      const result = await reconnectRazorpayFn({ data: { connectionId } });
      window.location.href = result.authorizationUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't reconnect Razorpay.");
      setReconnectingRazorpayId(null);
    }
  }

  async function handleVerifyRazorpay(connectionId: string) {
    setVerifyingRazorpayId(connectionId);
    try {
      const result = await verifyRazorpayFn({ data: { connectionId } });
      if (result.status === "CONNECTED") {
        toast.success("Razorpay connection verified.");
      } else if (result.status === "REAUTH_REQUIRED") {
        toast.error("Your Razorpay connection needs to be re-authorized.");
      } else if (result.status === "ERROR") {
        toast.error("Unable to verify your Razorpay connection. Please try again.");
      } else {
        toast.error("Razorpay is not connected.");
      }
      await queryClient.invalidateQueries({ queryKey: ["razorpay-connections"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't verify the Razorpay connection.");
    } finally {
      setVerifyingRazorpayId(null);
    }
  }

  async function handleDisconnectRazorpay(connectionId: string) {
    setDisconnectingRazorpayId(connectionId);
    try {
      await disconnectRazorpayFn({ data: { connectionId } });
      toast.success("Razorpay disconnected.");
      await queryClient.invalidateQueries({ queryKey: ["razorpay-connections"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect Razorpay.");
    } finally {
      setDisconnectingRazorpayId(null);
    }
  }

  async function handleConnectInstagram() {
    setConnectingInstagram(true);
    try {
      const businessId = instagramBusinessesRes.data?.[0]?.id ?? null;
      const result = await startInstagramFn({ data: { businessId } });
      window.location.href = result.authorizationUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the Instagram connection.");
      setConnectingInstagram(false);
    }
  }

  async function handleAssignInstagramBot(connectionId: string, agentConfigId: string | null) {
    setAssigningInstagramId(connectionId);
    try {
      await assignInstagramBotFn({ data: { connectionId, agentConfigId } });
      toast.success("Bot assignment updated.");
      await queryClient.invalidateQueries({ queryKey: ["instagram-connections"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the bot assignment.");
    } finally {
      setAssigningInstagramId(null);
    }
  }

  async function handleDisconnectInstagram(connectionId: string) {
    setDisconnectingInstagramId(connectionId);
    try {
      await disconnectInstagramFn({ data: { connectionId } });
      toast.success("Instagram disconnected.");
      await queryClient.invalidateQueries({ queryKey: ["instagram-connections"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect Instagram.");
    } finally {
      setDisconnectingInstagramId(null);
    }
  }

  async function handleSaveInstagramRule(input: {
    instagramConnectionId: string;
    name: string;
    triggerType: "comment_keyword" | "comment_any";
    keywords: string;
    actionType: "public_reply" | "private_dm" | "ai_dm";
    replyText: string;
    dmText: string;
  }) {
    setSavingInstagramRule(true);
    try {
      await upsertInstagramRuleFn({
        data: {
          instagramConnectionId: input.instagramConnectionId,
          name: input.name,
          triggerType: input.triggerType,
          triggerConfig: {
            keywords:
              input.triggerType === "comment_keyword"
                ? input.keywords
                    .split(",")
                    .map((k) => k.trim())
                    .filter(Boolean)
                : undefined,
          },
          actionType: input.actionType,
          actionConfig: {
            replyText: input.actionType === "public_reply" ? input.replyText : undefined,
            dmText: input.actionType === "private_dm" ? input.dmText : undefined,
          },
        },
      });
      toast.success("Automation rule added.");
      await queryClient.invalidateQueries({ queryKey: ["instagram-automation-rules"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that automation rule.");
    } finally {
      setSavingInstagramRule(false);
    }
  }

  async function handleToggleInstagramRule(id: string, enabled: boolean) {
    try {
      await toggleInstagramRuleFn({ data: { id, enabled } });
      await queryClient.invalidateQueries({ queryKey: ["instagram-automation-rules"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update that rule.");
    }
  }

  async function handleDeleteInstagramRule(id: string) {
    setDeletingInstagramRuleId(id);
    try {
      await deleteInstagramRuleFn({ data: { id } });
      await queryClient.invalidateQueries({ queryKey: ["instagram-automation-rules"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete that rule.");
    } finally {
      setDeletingInstagramRuleId(null);
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
        <>
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

          <div className="grid gap-4 sm:grid-cols-2">
            {businessesRes.data.map((business) => {
              const razorpayConnection =
                (razorpayConnectionsRes.data ?? []).find((c) => c.business_id === business.id) ??
                null;
              return (
                <RazorpayCard
                  key={business.id}
                  businessName={business.name}
                  configured={razorpayStatusRes.data?.configured ?? false}
                  connection={razorpayConnection}
                  connecting={connectingRazorpayFor === business.id}
                  onConnect={() => handleConnectRazorpay(business.id)}
                  verifying={verifyingRazorpayId === razorpayConnection?.id}
                  onVerify={() => razorpayConnection && handleVerifyRazorpay(razorpayConnection.id)}
                  reconnecting={reconnectingRazorpayId === razorpayConnection?.id}
                  onReconnect={() =>
                    razorpayConnection
                      ? handleReconnectRazorpay(razorpayConnection.id)
                      : handleConnectRazorpay(business.id)
                  }
                  disconnecting={disconnectingRazorpayId === razorpayConnection?.id}
                  onDisconnect={() =>
                    razorpayConnection && handleDisconnectRazorpay(razorpayConnection.id)
                  }
                />
              );
            })}
          </div>
        </>
      )}

      {(instagramBusinessesRes.data?.length ?? 0) > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <InstagramCard
            businessName={instagramBusinessesRes.data?.[0]?.name ?? "Your business"}
            configured={instagramStatusRes.data?.configured ?? false}
            connections={instagramConnectionsRes.data ?? []}
            businesses={instagramBusinessesRes.data ?? []}
            connecting={connectingInstagram}
            onConnect={handleConnectInstagram}
            assigningId={assigningInstagramId}
            onAssignBot={handleAssignInstagramBot}
            disconnectingId={disconnectingInstagramId}
            onDisconnect={handleDisconnectInstagram}
          />
        </div>
      ) : null}

      {(instagramConnectionsRes.data?.length ?? 0) > 0 ? (
        <InstagramAutomationRules
          connections={(instagramConnectionsRes.data ?? []).map((c) => ({
            id: c.id,
            username: c.username,
            instagram_business_account_id: c.instagram_business_account_id,
          }))}
          rules={
            (instagramAutomationRulesRes.data ?? []) as unknown as InstagramAutomationRuleSummary[]
          }
          saving={savingInstagramRule}
          onSave={handleSaveInstagramRule}
          deletingId={deletingInstagramRuleId}
          onDelete={handleDeleteInstagramRule}
          onToggle={handleToggleInstagramRule}
        />
      ) : null}
    </div>
  );
}
