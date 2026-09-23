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
import { completeWhatsAppOnboarding } from "@/lib/whatsapp-onboarding.functions";
import {
  startWhatsAppEmbeddedSignup,
  type EmbeddedSignupWindow,
} from "@/lib/whatsapp/embedded-signup-client";

export const Route = createFileRoute("/app/whatsapp")({
  head: () => ({
    meta: [
      { title: "WhatsApp — Vaani" },
      {
        name: "description",
        content: "Connect your business WhatsApp account to your AI agent.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: WhatsAppPage,
});

/**
 * Appends the Facebook JS SDK script tag once and resolves when it's
 * loaded — the real (non-test) implementation of embedded-signup-
 * client.ts's injectable `loadScript`. Kept in this route file, not the
 * shared client module, because it's genuinely DOM-mutating and the
 * shared module is deliberately kept free of any direct `document`
 * dependency so it stays testable under plain Node (see embedded-signup-
 * client.test.ts).
 */
function loadFacebookSdkScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Meta's SDK failed to load."));
    document.body.appendChild(script);
  });
}

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
  const completeOnboarding = useServerFn(completeWhatsAppOnboarding);
  const queryClient = useQueryClient();

  const { data: connections, isLoading: loadingConnections } = useQuery(
    connectionsQuery(whatsappLocked ? undefined : orgId, getConnections),
  );
  const { data: businesses } = useQuery(
    businessesQuery(whatsappLocked ? undefined : orgId, getBusinesses),
  );

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | undefined>(undefined);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  const refreshConnections = () =>
    queryClient.invalidateQueries({ queryKey: ["whatsapp-connections", orgId] });

  const onConnect = async () => {
    setConnectError(null);
    const appId = import.meta.env["VITE_META_APP_ID"] as string | undefined;
    const configId = import.meta.env["VITE_META_WHATSAPP_CONFIG_ID"] as string | undefined;
    const graphApiVersion = import.meta.env["VITE_META_GRAPH_API_VERSION"] as string | undefined;
    if (!appId || !configId || !graphApiVersion) {
      setConnectError("WhatsApp is not configured on this deployment yet. Please contact support.");
      return;
    }

    setConnecting(true);
    try {
      const outcome = await startWhatsAppEmbeddedSignup(
        { appId, configId, graphApiVersion },
        { win: window as unknown as EmbeddedSignupWindow, loadScript: loadFacebookSdkScript },
      );
      if (!outcome.ok) {
        if (outcome.reason !== "cancelled") setConnectError(outcome.message);
        return;
      }

      // The browser hands the server ONLY the minimum non-sensitive
      // result Meta returned (code, wabaId, phoneNumberId) plus the
      // business it picked. completeWhatsAppOnboarding (Phase 2) does
      // everything privileged from here — the browser never sees the
      // exchanged access token, the registration PIN, or any Meta secret.
      const result = await completeOnboarding({
        data: { ...outcome.result, businessId: selectedBusinessId ?? null },
      });
      toast.success(
        result.status === "connected"
          ? "WhatsApp connected."
          : "WhatsApp connected, but needs attention — see the connection below.",
      );
      await refreshConnections();
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Could not connect WhatsApp.");
    } finally {
      setConnecting(false);
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
          description="Uses Meta's official Embedded Signup — you authorize with your own Meta Business account, never with a token pasted here."
          actions={
            <Button
              size="sm"
              disabled={connecting || (businesses?.length ?? 0) === 0}
              onClick={onConnect}
            >
              {connecting ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" /> Connecting…
                </>
              ) : (
                "Connect WhatsApp"
              )}
            </Button>
          }
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

          {connectError ? (
            <div className="mb-4 rounded-lg border border-destructive/25 bg-destructive/12 px-3 py-2 text-xs text-destructive">
              {connectError}
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
    </div>
  );
}
