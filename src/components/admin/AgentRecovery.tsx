import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { confirmOutboundToolAuth, releaseSarvamAgentId } from "@/lib/provisioning-admin.functions";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Releases a wrongly reported Sarvam agent id (agent-recovery.server.ts). With `appId` the id
 * is fixed (a work order's reported agent); without it the admin types it.
 */
export function ReleaseAgentButton({
  orgId,
  customer,
  appId,
  onDone,
}: {
  orgId: string;
  customer: string;
  appId?: string;
  onDone: () => Promise<unknown>;
}) {
  const release = useServerFn(releaseSarvamAgentId);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const target = appId ?? typed.trim();
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {appId ? "Wrong agent ID?" : "Release a wrong agent ID"}
      </Button>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title={`Release a wrong agent ID for ${customer}`}
        description={`${appId ? `Agent ${appId}` : "The agent"} stops counting for this customer (${orgId}): its reports and confirmations are set aside and this customer's bridge tokens end. A registered agent cannot be released: register the correct one first. Nothing changes in Sarvam, and no number or deployment is touched.`}
        confirmLabel="Release"
        extra={
          appId ? null : (
            <Input
              aria-label="Sarvam agent id to release"
              placeholder="Sarvam agent id to release"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          )
        }
        onConfirm={async (reason) => {
          if (!target) throw new Error("Enter the Sarvam agent id");
          await release({ data: { orgId, sarvamAppId: target, reason } });
          setTyped("");
          toast.success("Released. Create a new bridge token to report the correct agent.");
          await onDone();
        }}
      />
    </>
  );
}

/** The admin's own tool-credential check for the registered outbound agent version. */
export function ConfirmOutboundToolsButton({
  orgId,
  appId,
  version,
  agentRef,
  onDone,
}: {
  orgId: string;
  appId: string;
  version: number;
  agentRef: string;
  onDone: () => Promise<unknown>;
}) {
  const confirm = useServerFn(confirmOutboundToolAuth);
  const [open, setOpen] = useState(false);
  const [seenRef, setSeenRef] = useState("");
  const [checked, setChecked] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Confirm outbound tool credentials
      </Button>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title="Confirm outbound tool credentials"
        description={`In Sarvam, open the committed version ${version} of ${appId}. Every ClickAI tool must use this customer's OUTBOUND credential and send the fixed body field agent_ref = ${agentRef}. ClickAI cannot check this itself. This does not switch outbound calling on.`}
        confirmLabel="Record confirmation"
        extra={
          <div className="space-y-2">
            <Input
              aria-label="agent_ref value on the tools"
              placeholder="agent_ref value you read on the tools"
              value={seenRef}
              onChange={(e) => setSeenRef(e.target.value)}
            />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <span>I checked every tool on this committed version.</span>
            </label>
          </div>
        }
        onConfirm={async (reason) => {
          if (!checked) throw new Error("Check every tool first, then tick the box");
          await confirm({
            data: {
              orgId,
              sarvamAppId: appId,
              sarvamAppVersion: version,
              agentRef: seenRef.trim(),
              everyToolChecked: checked,
              reason,
            },
          });
          setSeenRef("");
          setChecked(false);
          toast.success("Tool credentials recorded for this version.");
          await onDone();
        }}
      />
    </>
  );
}
