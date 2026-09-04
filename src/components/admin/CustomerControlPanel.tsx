import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Lock, Unlock, ShieldOff, ShieldCheck, Handshake } from "lucide-react";
import {
  lockCustomerAccount,
  unlockCustomerAccount,
  setPaymentOverride,
  handoverClient,
} from "@/lib/admin-clients.functions";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import type { LifecycleStatus } from "@/lib/lifecycle";

/**
 * Customer-level controls that are each a DIFFERENT concept from a per-feature
 * lock (ClientAccessPanel/feature list) and from a lifecycle move
 * (ClientLifecyclePanel):
 *
 * - Lock/Unlock customer: blocks every service at once via lifecycle=suspended.
 *   Restores the exact prior lifecycle stage on unlock rather than forcing
 *   "active".
 * - Payment override: bypasses the global payment-required switch for this
 *   customer only. Does not grant, lock or unlock any specific service.
 * - Handover: the one controlled path from READY to ACTIVE. Rejects with the
 *   real reason if setup payment (or an explicit override) is missing.
 */
export function CustomerControlPanel({
  orgId,
  lifecycle,
  paymentOverride,
  onChanged,
}: {
  orgId: string;
  lifecycle: LifecycleStatus;
  paymentOverride: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const lock = useServerFn(lockCustomerAccount);
  const unlock = useServerFn(unlockCustomerAccount);
  const override = useServerFn(setPaymentOverride);
  const handover = useServerFn(handoverClient);

  const [action, setAction] = useState<
    "lock" | "unlock" | "override-on" | "override-off" | "handover" | null
  >(null);

  const locked = lifecycle === "suspended";

  const run = async (reason: string) => {
    if (action === "lock") {
      await lock({ data: { orgId, reason } });
      toast.success("Customer locked — all services blocked, data preserved");
    } else if (action === "unlock") {
      await unlock({ data: { orgId, reason } });
      toast.success("Customer unlocked — restored to prior stage");
    } else if (action === "override-on") {
      await override({ data: { orgId, override: true, reason } });
      toast.success("Payment requirement overridden for this customer");
    } else if (action === "override-off") {
      await override({ data: { orgId, override: false, reason } });
      toast.success("Payment override removed — global policy applies again");
    } else if (action === "handover") {
      await handover({ data: { orgId, reason } });
      toast.success("Handover complete — customer is now ACTIVE");
    }
    setAction(null);
    await onChanged();
  };

  const dialogCopy: Record<NonNullable<typeof action>, { title: string; description: string }> = {
    lock: {
      title: "Lock this customer?",
      description:
        "Every service (including the dashboard view) becomes unavailable immediately. No data is deleted.",
    },
    unlock: {
      title: "Unlock this customer?",
      description:
        "Restores the lifecycle stage they were at before the lock. Individual services still pass their own checks.",
    },
    "override-on": {
      title: "Override payment requirement?",
      description:
        "This customer alone stops being payment-gated, regardless of the global switch. No payment, invoice or subscription is created.",
    },
    "override-off": {
      title: "Remove payment override?",
      description: "This customer goes back to following the global payment-required policy.",
    },
    handover: {
      title: "Hand over to ACTIVE?",
      description:
        "Only proceeds if setup payment is verified (or an override is set). Rejected otherwise, with the reason.",
    },
  };

  return (
    <SectionCard
      title="Customer controls"
      description="Platform-wide actions for this one customer — distinct from individual feature locks below."
      actions={
        <div className="flex flex-wrap gap-2">
          {locked ? (
            <Button size="sm" onClick={() => setAction("unlock")}>
              <Unlock className="mr-1.5 size-3.5" /> Unlock customer
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setAction("lock")}>
              <Lock className="mr-1.5 size-3.5" /> Lock customer
            </Button>
          )}
          {lifecycle === "ready" ? (
            <Button size="sm" variant="outline" onClick={() => setAction("handover")}>
              <Handshake className="mr-1.5 size-3.5" /> Hand over
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill tone={paymentOverride ? "accent" : "idle"}>
          {paymentOverride ? "Payment override active" : "Following global payment policy"}
        </StatusPill>
        {paymentOverride ? (
          <Button size="sm" variant="ghost" onClick={() => setAction("override-off")}>
            <ShieldOff className="mr-1.5 size-3.5" /> Remove override
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAction("override-on")}>
            <ShieldCheck className="mr-1.5 size-3.5" /> Override payment requirement
          </Button>
        )}
      </div>

      <ReasonDialog
        open={action !== null}
        onOpenChange={(open) => !open && setAction(null)}
        title={action ? dialogCopy[action].title : ""}
        description={action ? dialogCopy[action].description : ""}
        onConfirm={run}
      />
    </SectionCard>
  );
}
