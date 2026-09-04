import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Phone, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  listPhoneNumbers,
  provisionPhoneNumber,
  activatePhoneNumber,
  suspendPhoneNumber,
  releasePhoneNumber,
  setNumberDirection,
  listTelephonyProviderDefs,
} from "@/lib/telephony-admin.functions";
import {
  PageHeader,
  SectionCard,
  LoadingState,
  ErrorState,
  EmptyState,
  StatusPill,
} from "@/components/app/primitives";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/admin/numbers")({
  component: AdminNumbers,
});

const STATUS_TONE: Record<string, "live" | "ready" | "idle" | "error" | "accent"> = {
  active: "live",
  provisioning: "ready",
  pending: "idle",
  suspended: "error",
  released: "idle",
  failed: "error",
};

type NumberRow = Awaited<ReturnType<typeof listPhoneNumbers>>[number];

function AdminNumbers() {
  const fetchNumbers = useServerFn(listPhoneNumbers);
  const fetchProviders = useServerFn(listTelephonyProviderDefs);
  const provision = useServerFn(provisionPhoneNumber);
  const activate = useServerFn(activatePhoneNumber);
  const suspend = useServerFn(suspendPhoneNumber);
  const release = useServerFn(releasePhoneNumber);
  const setDirection = useServerFn(setNumberDirection);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-numbers"],
    queryFn: () => fetchNumbers({ data: {} }),
  });
  const { data: providerData } = useQuery({
    queryKey: ["admin-telephony-providers"],
    queryFn: () => fetchProviders(),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [target, setTarget] = useState<{ row: NumberRow; action: "suspend" | "release" } | null>(
    null,
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-numbers"] });

  if (isLoading) return <LoadingState label="Loading phone numbers" />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load phone numbers"}
        onRetry={() => void refetch()}
      />
    );

  const rows = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phone numbers"
        description="Provision, assign, suspend and release numbers. Every number belongs to exactly one active customer at a time."
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 size-3.5" /> Provision number
          </Button>
        }
      />

      <SectionCard title={`${rows.length} numbers`}>
        {rows.length === 0 ? (
          <EmptyState
            icon={Phone}
            title="No numbers yet"
            description="Provision the first number to get started."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4">Number</th>
                  <th className="py-2 pr-4">Customer</th>
                  <th className="py-2 pr-4">Provider</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Inbound</th>
                  <th className="py-2 pr-4">Outbound</th>
                  <th className="py-2 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((n) => (
                  <tr key={n.id}>
                    <td className="py-2.5 pr-4 font-mono text-xs">{n.display_number ?? n.e164}</td>
                    <td className="py-2.5 pr-4">
                      <p className="font-medium">{n.customerName}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{n.clientId}</p>
                    </td>
                    <td className="py-2.5 pr-4 text-xs">{n.provider}</td>
                    <td className="py-2.5 pr-4">
                      <StatusPill tone={STATUS_TONE[n.status] ?? "idle"}>{n.status}</StatusPill>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Switch
                        checked={n.inbound_enabled}
                        disabled={n.status !== "active"}
                        onCheckedChange={async (checked) => {
                          try {
                            await setDirection({
                              data: {
                                numberId: n.id,
                                direction: "inbound",
                                enabled: checked,
                                reason: "Toggled from admin numbers screen",
                              },
                            });
                            invalidate();
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : "Failed to update");
                          }
                        }}
                      />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Switch
                        checked={n.outbound_enabled}
                        disabled={n.status !== "active"}
                        onCheckedChange={async (checked) => {
                          try {
                            await setDirection({
                              data: {
                                numberId: n.id,
                                direction: "outbound",
                                enabled: checked,
                                reason: "Toggled from admin numbers screen",
                              },
                            });
                            invalidate();
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : "Failed to update");
                          }
                        }}
                      />
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex gap-1.5">
                        {n.status === "provisioning" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              try {
                                await activate({
                                  data: {
                                    numberId: n.id,
                                    reason: "Activated from admin numbers screen",
                                  },
                                });
                                invalidate();
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Failed to activate",
                                );
                              }
                            }}
                          >
                            Activate
                          </Button>
                        ) : null}
                        {n.status === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setTarget({ row: n, action: "suspend" })}
                          >
                            Suspend
                          </Button>
                        ) : null}
                        {n.status !== "released" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setTarget({ row: n, action: "release" })}
                          >
                            Release
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <AddNumberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        providers={providerData?.providers ?? []}
        onSubmit={async (input) => {
          await provision({ data: input });
          invalidate();
        }}
      />

      <ReasonDialog
        open={Boolean(target)}
        onOpenChange={(open) => !open && setTarget(null)}
        title={target?.action === "suspend" ? "Suspend number" : "Release number"}
        description={
          target?.action === "suspend"
            ? "The number stays assigned but stops accepting inbound and outbound traffic."
            : "The number is permanently released from this customer. It cannot be reactivated afterwards — provision a new one if needed."
        }
        confirmLabel={target?.action === "suspend" ? "Suspend" : "Release"}
        onConfirm={async (reason) => {
          if (!target) return;
          if (target.action === "suspend")
            await suspend({ data: { numberId: target.row.id, reason } });
          else await release({ data: { numberId: target.row.id, reason } });
          invalidate();
        }}
      />
    </div>
  );
}

function AddNumberDialog({
  open,
  onOpenChange,
  providers,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: { id: string; label: string; configured: boolean; supportsPurchase: boolean }[];
  onSubmit: (input: {
    orgId: string;
    provider: string;
    purchase: boolean;
    e164?: string;
    displayNumber?: string;
    reason: string;
  }) => Promise<void>;
}) {
  const [orgId, setOrgId] = useState("");
  const [provider, setProvider] = useState("");
  const [e164, setE164] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Provision a number</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="space-y-2.5">
          <Input
            placeholder="Organization ID"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          />
          <Input
            placeholder="Provider (e.g. exotel, twilio, sarvam)"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <Input
            placeholder="E.164 number already purchased in the provider console (e.g. +919876543210)"
            value={e164}
            onChange={(e) => setE164(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {providers.find((p) => p.id === provider)?.configured === false
              ? "This provider is not connected yet — set its credentials in the environment before self-service purchase works."
              : "Enter the E.164 number your team already provisioned in the provider's own console; self-service purchase is not enabled for every provider."}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !orgId.trim() || !provider.trim() || !e164.trim()}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onSubmit({
                  orgId: orgId.trim(),
                  provider: provider.trim(),
                  purchase: false,
                  e164: e164.trim(),
                  displayNumber: e164.trim(),
                  reason: "Provisioned from admin numbers screen",
                });
                setOrgId("");
                setProvider("");
                setE164("");
                onOpenChange(false);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to provision number");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Provisioning…" : "Provision"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
