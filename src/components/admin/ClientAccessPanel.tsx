import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Copy, KeyRound, Ban } from "lucide-react";
import { listInvitations, createInvitation, revokeInvitation } from "@/lib/admin-clients.functions";
import { SectionCard, StatusPill, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReasonDialog } from "@/components/admin/ReasonDialog";

/**
 * Invitation management. Only SHA-256 hashes of the link token and PIN are
 * stored — the raw values are shown once here and can never be read back,
 * not from the database and not from any API.
 */
export function ClientAccessPanel({ orgId, defaultEmail }: { orgId: string; defaultEmail: string | null }) {
  const fetchInvites = useServerFn(listInvitations);
  const create = useServerFn(createInvitation);
  const revoke = useServerFn(revokeInvitation);

  const [email, setEmail] = useState(defaultEmail ?? "");
  const [withPin, setWithPin] = useState(true);
  const [issued, setIssued] = useState<{ link: string; pin: string | null } | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, refetch } = useQuery({
    queryKey: ["admin-invites", orgId],
    queryFn: () => fetchInvites({ data: { orgId } }),
  });

  const generate = async () => {
    setBusy(true);
    try {
      const result = await create({ data: { orgId, email, withPin } });
      const link = `${window.location.origin}/invite?token=${result.token}`;
      setIssued({ link, pin: result.pin });
      toast.success("Invitation generated — copy it now, it cannot be shown again");
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not generate invitation");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast.success("Copied");
  };

  return (
    <SectionCard
      title="Customer access"
      description="Issue a secure, expiring invitation. The customer signs in with their own credentials — you never hold their password or PIN."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Invitation email</Label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@business.in" />
        </div>
        <label className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={withPin} onChange={(e) => setWithPin(e.target.checked)} />
          Require 6-digit PIN
        </label>
        <Button size="sm" disabled={busy} onClick={generate}>
          <KeyRound className="mr-1.5 size-3.5" /> {busy ? "Generating…" : "Generate invitation"}
        </Button>
      </div>

      {issued ? (
        <div className="mt-4 space-y-2 rounded-lg border border-primary/30 bg-primary/8 p-3 text-sm">
          <p className="text-xs text-muted-foreground">Shown once. Send it to the customer through a channel you trust.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{issued.link}</code>
            <Button size="sm" variant="outline" onClick={() => copy(issued.link)}>
              <Copy className="size-3.5" />
            </Button>
          </div>
          {issued.pin ? (
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 text-xs tracking-[0.3em]">{issued.pin}</code>
              <Button size="sm" variant="outline" onClick={() => copy(issued.pin!)}>
                <Copy className="size-3.5" />
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Automatic invitation email is not available yet — no email provider is connected to this project.
          </p>
        </div>
      ) : null}

      <div className="mt-5">
        {data?.length ? (
          <ul className="divide-y divide-border">
            {data.map((inv) => {
              const state = inv.accepted_at
                ? { tone: "live" as const, label: "Accepted" }
                : inv.revoked_at
                  ? { tone: "idle" as const, label: "Revoked" }
                  : new Date(inv.expires_at) < new Date()
                    ? { tone: "error" as const, label: "Expired" }
                    : { tone: "ready" as const, label: "Pending" };
              return (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span>{inv.email}</span>
                  <span className="text-xs text-muted-foreground tabular">
                    expires {new Date(inv.expires_at).toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {inv.failed_attempts > 0 ? `${inv.failed_attempts} failed attempts` : "no failed attempts"}
                  </span>
                  <StatusPill tone={state.tone}>{state.label}</StatusPill>
                  {!inv.accepted_at && !inv.revoked_at ? (
                    <Button size="sm" variant="ghost" onClick={() => setRevokeId(inv.id)}>
                      <Ban className="mr-1.5 size-3.5" /> Revoke
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No invitations issued" description="Generate one when the workspace is ready." />
        )}
      </div>

      <ReasonDialog
        open={revokeId !== null}
        onOpenChange={(open) => !open && setRevokeId(null)}
        title="Revoke this invitation?"
        description="The link and PIN stop working immediately. You can issue a new one at any time."
        confirmLabel="Revoke"
        onConfirm={async (reason) => {
          await revoke({ data: { invitationId: revokeId!, reason } });
          toast.success("Invitation revoked");
          setRevokeId(null);
          await refetch();
        }}
      />
    </SectionCard>
  );
}
