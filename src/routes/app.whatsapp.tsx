import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { MessageCircle, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery } from "@/lib/workspace";
import { featureLocksQuery } from "@/lib/access";
import {
  PageHeader,
  SectionCard,
  StatusPill,
  LoadingState,
  EmptyState,
} from "@/components/app/primitives";
import { ServiceLocked } from "@/components/app/ServiceLocked";
import { WhatsAppConversationsPanel } from "@/components/app/WhatsAppConversationsPanel";
import { WhatsAppMessagingPanel } from "@/components/app/WhatsAppMessagingPanel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
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
  listWhatsAppConnections,
  listOrgBusinessesForWhatsApp,
  assignWhatsAppBot,
  disconnectWhatsAppConnection,
} from "@/lib/whatsapp-connection.functions";
import {
  listDisconnectedWhatsAppNumbers,
  reconnectWhatsAppConnection,
} from "@/lib/whatsapp-onboarding.functions";
import { WhatsAppConnectOptions } from "@/components/app/WhatsAppConnectOptions";

export const Route = createFileRoute("/app/whatsapp")({
  head: () => ({
    meta: [
      { title: "WhatsApp — ClickAI" },
      {
        name: "description",
        content: "Connect your business WhatsApp account to your AI agent.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: WhatsAppPage,
});

const connectionsQuery = (
  orgId: string | undefined,
  fn: ReturnType<typeof useServerFn<typeof listWhatsAppConnections>>,
) =>
  queryOptions({
    queryKey: ["whatsapp-connections", orgId],
    enabled: Boolean(orgId),
    queryFn: () => fn(),
  });

const businessesQuery = (
  orgId: string | undefined,
  fn: ReturnType<typeof useServerFn<typeof listOrgBusinessesForWhatsApp>>,
) =>
  queryOptions({
    queryKey: ["whatsapp-org-businesses", orgId],
    enabled: Boolean(orgId),
    queryFn: () => fn(),
  });

function statusTone(status: string): "live" | "ready" | "idle" | "error" {
  if (status === "connected") return "live";
  if (status === "needs_attention" || status === "connecting") return "ready";
  if (status === "error") return "error";
  return "idle";
}

function statusLabel(status: string): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "needs_attention":
      return "Needs attention";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Connection error";
    default:
      return "Not connected";
  }
}

function WhatsAppPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const lifecycle = ws?.organization?.lifecycle_status ?? "not_provisioned";
  const { data: locks } = useQuery(featureLocksQuery(orgId));
  const whatsappLocked = locks?.["whatsapp"] === true;

  const getConnections = useServerFn(listWhatsAppConnections);
  const getBusinesses = useServerFn(listOrgBusinessesForWhatsApp);
  const assignBot = useServerFn(assignWhatsAppBot);
  const disconnectConnection = useServerFn(disconnectWhatsAppConnection);
  const getDisconnected = useServerFn(listDisconnectedWhatsAppNumbers);
  const reconnect = useServerFn(reconnectWhatsAppConnection);
  const queryClient = useQueryClient();

  const { data: connections, isLoading: loadingConnections } = useQuery(
    connectionsQuery(whatsappLocked ? undefined : orgId, getConnections),
  );
  const { data: businesses } = useQuery(
    businessesQuery(whatsappLocked ? undefined : orgId, getBusinesses),
  );

  const { data: disconnected } = useQuery({
    queryKey: ["whatsapp-disconnected", orgId],
    enabled: Boolean(orgId) && !whatsappLocked,
    queryFn: () => getDisconnected(),
    retry: false,
  });
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | undefined>(undefined);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  const refreshConnections = async () => {
    await queryClient.invalidateQueries({ queryKey: ["whatsapp-connections", orgId] });
    await queryClient.invalidateQueries({ queryKey: ["whatsapp-disconnected", orgId] });
  };
  // With several businesses the number must be attached to a chosen one.
  const targetBusinessId =
    (businesses?.length ?? 0) === 1 ? (businesses?.[0]?.id ?? null) : (selectedBusinessId ?? null);
  const needsBusinessChoice = (businesses?.length ?? 0) > 1 && !selectedBusinessId;

  const onReconnect = async (connectionId: string) => {
    setReconnectingId(connectionId);
    try {
      await reconnect({ data: { connectionId } });
      toast.success("WhatsApp reconnected.");
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reconnect WhatsApp.");
    } finally {
      setReconnectingId(null);
    }
  };

  const onAssignBot = async (connectionId: string, agentConfigId: string | null) => {
    setAssigningId(connectionId);
    try {
      await assignBot({ data: { connectionId, agentConfigId } });
      toast.success("Bot assignment updated.");
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the bot assignment.");
    } finally {
      setAssigningId(null);
    }
  };

  const onDisconnect = async (connectionId: string) => {
    setDisconnectingId(connectionId);
    try {
      await disconnectConnection({ data: { connectionId } });
      toast.success("WhatsApp disconnected.");
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect WhatsApp.");
    } finally {
      setDisconnectingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="WhatsApp"
        description="Connect your business WhatsApp account and let your AI agent handle customer conversations automatically."
      />

      {loadingConnections ? (
        <LoadingState label="Loading your WhatsApp connections" />
      ) : whatsappLocked ? (
        <ServiceLocked feature="whatsapp" lifecycle={lifecycle} />
      ) : (
        <SectionCard
          title="Connect WhatsApp"
          description="Connected through Vobiz, our WhatsApp provider. Bring your own number, buy one, or use Meta's Embedded Signup. Owners and admins can connect numbers."
        >
          {(businesses?.length ?? 0) > 1 ? (
            <div className="mb-4 max-w-sm space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Which business is this WhatsApp number for?
              </label>
              <Select value={selectedBusinessId ?? ""} onValueChange={setSelectedBusinessId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a business" />
                </SelectTrigger>
                <SelectContent>
                  {businesses?.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {(businesses?.length ?? 0) === 0 ? (
            <p className="mb-4 text-xs text-muted-foreground">
              Set up a business profile first — WhatsApp connects to a business/bot, and your
              workspace doesn't have one yet.
            </p>
          ) : null}

          {orgId && (businesses?.length ?? 0) > 0 ? (
            <div className="mb-6 rounded-lg border border-border p-4">
              <WhatsAppConnectOptions
                orgId={orgId}
                businessId={targetBusinessId}
                disabled={needsBusinessChoice}
                onConnected={refreshConnections}
              />
              {needsBusinessChoice ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Choose which business this number is for first.
                </p>
              ) : null}
            </div>
          ) : null}

          {disconnected && disconnected.length > 0 ? (
            <div className="mb-6 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Disconnected numbers</p>
              {disconnected.map((d) => (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                >
                  <span className="font-mono text-sm">
                    {d.display_phone_number ?? d.phone_number_id}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reconnectingId !== null}
                    onClick={() => onReconnect(d.id)}
                  >
                    {reconnectingId === d.id ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : null}
                    Reconnect
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {connections && connections.length > 0 ? (
            <div className="space-y-3">
              {connections.map((c) => {
                const assignedBusiness = businesses?.find(
                  (b) => b.agentConfig?.id === c.agent_config_id,
                );
                return (
                  <div key={c.id} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-mono text-lg">
                          {c.display_phone_number ?? c.phone_number_id}
                        </p>
                        {c.verified_name ? (
                          <p className="text-xs text-muted-foreground">{c.verified_name}</p>
                        ) : null}
                      </div>
                      <StatusPill tone={statusTone(c.status)}>{statusLabel(c.status)}</StatusPill>
                    </div>

                    {c.status === "error" || c.status === "needs_attention" ? (
                      c.last_error ? (
                        <p className="mt-2 text-xs text-warning">{c.last_error}</p>
                      ) : null
                    ) : null}

                    <div className="mt-3 max-w-sm space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">
                        Assigned business / bot
                      </label>
                      <Select
                        value={
                          businesses?.find((b) => b.agentConfig?.id === c.agent_config_id)?.id ?? ""
                        }
                        onValueChange={(businessId) => {
                          const b = businesses?.find((x) => x.id === businessId);
                          onAssignBot(c.id, b?.agentConfig?.id ?? null);
                        }}
                        disabled={assigningId === c.id}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Not assigned" />
                        </SelectTrigger>
                        <SelectContent>
                          {businesses?.map((b) => (
                            <SelectItem key={b.id} value={b.id} disabled={!b.agentConfig}>
                              {b.name}
                              {b.agentConfig
                                ? ` — ${b.agentConfig.agentName}`
                                : " (no bot configured)"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!assignedBusiness ? (
                        <p className="text-xs text-muted-foreground">
                          No bot assigned yet — WhatsApp messages won't be answered until one is
                          selected.
                        </p>
                      ) : null}
                    </div>

                    <div className="mt-3 flex justify-end">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="outline" disabled={disconnectingId === c.id}>
                            {disconnectingId === c.id ? "Disconnecting…" : "Disconnect WhatsApp"}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Disconnect WhatsApp?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Your WhatsApp number will no longer be connected to this ClickAI bot.
                              Existing conversation history is kept, not deleted.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => onDisconnect(c.id)}>
                              Disconnect
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={MessageCircle}
              title="No WhatsApp number connected yet"
              description="Connect your business WhatsApp account and your AI agent will start answering messages automatically."
            />
          )}
        </SectionCard>
      )}

      {!whatsappLocked && orgId && connections && connections.length > 0 ? (
        <>
          <WhatsAppConversationsPanel orgId={orgId} />
          <WhatsAppMessagingPanel orgId={orgId} />
        </>
      ) : null}
    </div>
  );
}
