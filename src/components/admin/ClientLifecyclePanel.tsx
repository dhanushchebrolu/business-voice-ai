import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Archive, LogIn } from "lucide-react";
import { setClientLifecycle, archiveClient, startSupportSession } from "@/lib/admin-clients.functions";
import { LIFECYCLE, LIFECYCLE_ORDER, type LifecycleStatus } from "@/lib/lifecycle";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReasonDialog } from "@/components/admin/ReasonDialog";

/**
 * Lifecycle control for one client, plus archive and the audited support
 * (impersonation) session. Every action is server-verified and written to the
 * audit log with a mandatory reason.
 */
export function ClientLifecyclePanel({
  orgId,
  clientId,
  name,
  current,
  onChanged,
}: {
  orgId: string;
  clientId: string;
  name: string;
  current: LifecycleStatus;
  onChanged: () => Promise<void> | void;
}) {
  const move = useServerFn(setClientLifecycle);
  const archive = useServerFn(archiveClient);
  const startSupport = useServerFn(startSupportSession);
  const navigate = useNavigate();

  const [target, setTarget] = useState<LifecycleStatus | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [supportOpen, setSupportOpen] = useState(false);

  const meta = LIFECYCLE[current];

  return (
    <SectionCard
      title="Lifecycle & access"
      description="Nothing unlocks for the customer until you move them through these states. Enforced server-side."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setSupportOpen(true)}>
            <LogIn className="mr-1.5 size-3.5" /> Access dashboard
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setArchiveOpen(true)}>
            <Archive className="mr-1.5 size-3.5" /> Archive client
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
        <span className="text-xs text-muted-foreground">{meta.description}</span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {LIFECYCLE_ORDER.filter((s) => s !== "archived").map((s) => (
          <Button
            key={s}
            size="sm"
            variant={current === s ? "default" : "outline"}
            disabled={current === s}
            onClick={() => setTarget(s)}
          >
            {LIFECYCLE[s].label}
          </Button>
        ))}
      </div>

      <ReasonDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`Move ${clientId} to “${target ? LIFECYCLE[target].label : ""}”?`}
        description="This changes what the customer can reach immediately and is recorded in the audit log."
        onConfirm={async (reason) => {
          await move({ data: { orgId, status: target!, reason } });
          toast.success("Lifecycle updated");
          setTarget(null);
          await onChanged();
        }}
      />

      <ReasonDialog
        open={archiveOpen}
        onOpenChange={(open) => {
          setArchiveOpen(open);
          if (!open) setConfirmation("");
        }}
        title={`Archive ${clientId} / ${name}?`}
        description="Access is revoked and outstanding invitations are cancelled. Payments, wallet ledger, invoices, calls, usage and audit history are preserved — nothing financial is deleted."
        confirmLabel="Archive client"
        extra={
          <Input
            placeholder={`Type ${clientId} to confirm`}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        }
        onConfirm={async (reason) => {
          await archive({ data: { orgId, confirmation, reason } });
          toast.success("Client archived");
          setConfirmation("");
          await onChanged();
        }}
      />

      <ReasonDialog
        open={supportOpen}
        onOpenChange={setSupportOpen}
        title="Start an admin support session?"
        description="Opens a read-only view of this customer's workspace for up to 30 minutes. You never see or change their password, and the customer sees a support banner on their dashboard."
        confirmLabel="Start session"
        onConfirm={async (reason) => {
          const session = await startSupportSession
            ? await startSupport({ data: { orgId, reason } })
            : null;
          if (!session) throw new Error("Could not start the session");
          sessionStorage.setItem("vaani.support", JSON.stringify({ id: session.sessionId, token: session.token }));
          setSupportOpen(false);
          navigate({ to: "/admin/support" });
        }}
      />
    </SectionCard>
  );
}
