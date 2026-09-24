import { Loader2, Instagram as InstagramIcon, CheckCircle2, AlertTriangle } from "lucide-react";
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
import { StatusPill } from "@/components/app/primitives";

/**
 * Instagram connection card — one per connected account, mirroring
 * RazorpayCard.tsx's structure/state-machine shape (spec §16 states:
 * Not connected / Connecting / Connected / Error / Reconnect / Disconnect)
 * but using instagram_connections' own status vocabulary (not_connected/
 * connecting/connected/error/disconnected/needs_attention — the same
 * vocabulary whatsapp_connections already uses, not Razorpay's
 * differently-named one). Never renders access_token_ciphertext or any
 * other secret — the connection summary type below doesn't even include
 * that field, matching the column-level GRANT the migration already
 * enforces server-side.
 */

export interface InstagramConnectionSummary {
  id: string;
  business_id: string | null;
  agent_config_id: string | null;
  instagram_business_account_id: string;
  facebook_page_id: string;
  username: string | null;
  display_name: string | null;
  profile_picture_url: string | null;
  status: string;
  webhook_subscribed: boolean;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
}

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

export function InstagramCard({
  businessName,
  configured,
  connections,
  businesses,
  connecting,
  onConnect,
  assigningId,
  onAssignBot,
  disconnectingId,
  onDisconnect,
}: {
  businessName: string;
  /** Whether Instagram is configured on this deployment at all (META_APP_ID/SECRET/INSTAGRAM_REDIRECT_URI present). */
  configured: boolean;
  connections: InstagramConnectionSummary[];
  businesses: { id: string; name: string; agentConfig: { id: string; agentName: string } | null }[];
  connecting: boolean;
  onConnect: () => void;
  assigningId: string | null;
  onAssignBot: (connectionId: string, agentConfigId: string | null) => void;
  disconnectingId: string | null;
  onDisconnect: (connectionId: string) => void;
}) {
  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-muted">
            <InstagramIcon className="size-4 text-muted-foreground" />
          </span>
          <div>
            <p className="text-sm font-semibold">Instagram</p>
            <p className="text-xs text-muted-foreground">{businessName}</p>
          </div>
        </div>
        {!configured ? (
          <StatusPill tone="idle">Not configured</StatusPill>
        ) : connections.length === 0 ? (
          <StatusPill tone="idle">Not connected</StatusPill>
        ) : null}
      </div>

      {!configured ? (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Connect your Instagram professional account to answer DMs and comments with your AI
            agent.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Status: Not configured</p>
          <Button
            className="mt-4"
            disabled
            title="Contact your ClickAI administrator to enable Instagram for this workspace."
          >
            Configure Instagram
          </Button>
        </div>
      ) : connections.length === 0 ? (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Uses Meta's official Facebook Login — you authorize with your own Instagram professional
            account, never a token pasted here. Requires an Instagram Business or Creator account
            linked to a Facebook Page.
          </p>
          <Button className="mt-4" onClick={onConnect} disabled={connecting}>
            {connecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            {connecting ? "Connecting…" : "Connect Instagram"}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {connections.map((c) => {
            const assignedBusiness = businesses.find(
              (b) => b.agentConfig?.id === c.agent_config_id,
            );
            return (
              <div key={c.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {c.username
                        ? `@${c.username}`
                        : c.display_name || c.instagram_business_account_id}
                    </p>
                    {c.display_name && c.username ? (
                      <p className="text-xs text-muted-foreground">{c.display_name}</p>
                    ) : null}
                  </div>
                  <StatusPill tone={statusTone(c.status)}>{statusLabel(c.status)}</StatusPill>
                </div>

                {(c.status === "error" || c.status === "needs_attention") && c.last_error ? (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/5 p-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <p className="text-xs text-warning">{c.last_error}</p>
                  </div>
                ) : null}
                {c.status === "connected" ? (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle2 className="size-3.5" /> Connected
                  </div>
                ) : null}

                <div className="mt-3 max-w-sm space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Assigned business / bot
                  </label>
                  <Select
                    value={
                      businesses.find((b) => b.agentConfig?.id === c.agent_config_id)?.id ?? ""
                    }
                    onValueChange={(businessId) => {
                      const b = businesses.find((x) => x.id === businessId);
                      onAssignBot(c.id, b?.agentConfig?.id ?? null);
                    }}
                    disabled={assigningId === c.id}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Not assigned" />
                    </SelectTrigger>
                    <SelectContent>
                      {businesses.map((b) => (
                        <SelectItem key={b.id} value={b.id} disabled={!b.agentConfig}>
                          {b.name}
                          {b.agentConfig ? ` — ${b.agentConfig.agentName}` : " (no bot configured)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!assignedBusiness ? (
                    <p className="text-xs text-muted-foreground">
                      No bot assigned yet — Instagram DMs won't be answered until one is selected.
                    </p>
                  ) : null}
                </div>

                <div className="mt-3 flex justify-end">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="outline" disabled={disconnectingId === c.id}>
                        {disconnectingId === c.id ? "Disconnecting…" : "Disconnect Instagram"}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Disconnect Instagram?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Your Instagram account will no longer be connected to this ClickAI bot.
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
          <Button variant="outline" size="sm" onClick={onConnect} disabled={connecting}>
            {connecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Connect another Instagram account
          </Button>
        </div>
      )}
    </div>
  );
}
