import { Loader2, Wallet, CheckCircle2, AlertTriangle } from "lucide-react";
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
 * Razorpay merchant CONNECTION card — one per business. Phase 3 scope
 * only: Connect/Verify/Reconnect/Disconnect. No "Create Payment"/"Create
 * QR"/"Send Payment"/"Refund" button — those are Phase 4. Purely
 * presentational, mirroring GoogleCalendarCard.tsx's structure exactly:
 * all data and mutations are owned by the parent route
 * (app.integrations.tsx).
 *
 * Copy blocks below are verbatim from the Phase 3 spec for each of the
 * six connection states (NOT_CONFIGURED/DISCONNECTED/CONNECTING/CONNECTED/
 * REAUTH_REQUIRED/ERROR) — never invented or paraphrased.
 */

export interface RazorpayConnectionSummary {
  id: string;
  business_id: string | null;
  connection_status: string;
  merchant_status: string | null;
  razorpay_account_id: string | null;
  business_name: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  connected_at: string | null;
  last_verified_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
}

export function RazorpayCard({
  businessName,
  configured,
  connection,
  connecting,
  onConnect,
  verifying,
  onVerify,
  reconnecting,
  onReconnect,
  disconnecting,
  onDisconnect,
}: {
  businessName: string;
  /** Whether Razorpay is configured on this deployment at all (RAZORPAY_CLIENT_ID/SECRET/etc. present) — distinct from whether THIS business has connected. */
  configured: boolean;
  connection: RazorpayConnectionSummary | null;
  connecting: boolean;
  onConnect: () => void;
  verifying: boolean;
  onVerify: () => void;
  reconnecting: boolean;
  onReconnect: () => void;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  const status = !configured ? "NOT_CONFIGURED" : (connection?.connection_status ?? "DISCONNECTED");

  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-muted">
            <Wallet className="size-4 text-muted-foreground" />
          </span>
          <div>
            <p className="text-sm font-semibold">Razorpay</p>
            <p className="text-xs text-muted-foreground">{businessName}</p>
          </div>
        </div>
        {status === "CONNECTED" ? (
          <StatusPill tone="live">Connected</StatusPill>
        ) : status === "REAUTH_REQUIRED" || status === "ERROR" ? (
          <StatusPill tone="error">Needs attention</StatusPill>
        ) : status === "NOT_CONFIGURED" ? (
          <StatusPill tone="idle">Not configured</StatusPill>
        ) : (
          <StatusPill tone="idle">Not connected</StatusPill>
        )}
      </div>

      {status === "NOT_CONFIGURED" && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Accept payments directly through your business's Razorpay account.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Status: Not configured</p>
          <Button
            className="mt-4"
            disabled
            title="Contact your ClickAI administrator to enable Razorpay for this workspace."
          >
            Configure Razorpay
          </Button>
        </div>
      )}

      {status === "DISCONNECTED" && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Connect your Razorpay account to accept customer payments through ClickAI.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Status: Not connected</p>
          <Button className="mt-4" onClick={onConnect} disabled={connecting}>
            {connecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            {connecting ? "Connecting…" : "Connect Razorpay"}
          </Button>
        </div>
      )}

      {status === "REAUTH_REQUIRED" && (
        <div className="mt-4">
          <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">
              Your Razorpay connection needs to be re-authorized.
            </p>
          </div>
          <Button className="mt-4" onClick={onReconnect} disabled={reconnecting}>
            {reconnecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Reconnect
          </Button>
        </div>
      )}

      {status === "ERROR" && (
        <div className="mt-4">
          <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">
              Unable to verify your Razorpay connection. Please try again.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" onClick={onVerify} disabled={verifying}>
              {verifying ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Verify Connection
            </Button>
            <Button onClick={onReconnect} disabled={reconnecting}>
              {reconnecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Reconnect
            </Button>
          </div>
        </div>
      )}

      {status === "CONNECTED" && connection && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="size-4" /> Connected
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Business</dt>
            <dd>{connection.business_name ?? connection.display_name ?? "—"}</dd>
            <dt className="text-muted-foreground">Razorpay Account</dt>
            <dd className="font-mono text-xs">{connection.razorpay_account_id ?? "—"}</dd>
            <dt className="text-muted-foreground">Connected</dt>
            <dd>
              {connection.connected_at
                ? new Date(connection.connected_at).toLocaleDateString()
                : "—"}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onVerify} disabled={verifying}>
              {verifying ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Verify Connection
            </Button>
            <Button variant="outline" size="sm" onClick={onReconnect} disabled={reconnecting}>
              {reconnecting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Reconnect
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
                  <AlertDialogTitle>Disconnect Razorpay?</AlertDialogTitle>
                  <AlertDialogDescription>
                    ClickAI will stop using this Razorpay account for {businessName}. Your Razorpay
                    account itself and any historical payment records are not affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDisconnect}>Disconnect</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}
    </div>
  );
}
