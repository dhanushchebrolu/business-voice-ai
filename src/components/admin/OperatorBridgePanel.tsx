import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import {
  getOperatorBridgeStatus,
  issueOperatorBridgeToken,
  revokeOperatorBridgeTokens,
} from "@/lib/operator-bridge.functions";
import { ErrorState, LoadingState, SectionCard, StatusPill } from "@/components/app/primitives";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { Button } from "@/components/ui/button";

const when = (v: string) => new Date(v).toLocaleString();

type Checkpoint = NonNullable<
  Awaited<ReturnType<typeof getOperatorBridgeStatus>>["workOrders"][number]["checkpoint"]
>;

/** A job paused until a person selects each tool's credential in the Sarvam console. */
function ToolAuthCheckpointCard({
  checkpoint: c,
  onCopy,
}: {
  checkpoint: Checkpoint;
  onCopy: (text: string) => void;
}) {
  return (
    <div
      className="mt-2 w-full space-y-2 rounded-md border border-border bg-muted/40 p-3"
      data-testid="tool-auth-checkpoint"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">Customer</dt>
        <dd>
          {c.customer} <code>{c.customerId}</code>
        </dd>
        <dt className="text-muted-foreground">Provisioning job</dt>
        <dd>
          <code>{c.jobId}</code>
        </dd>
        <dt className="text-muted-foreground">Sarvam agent ID</dt>
        <dd>
          <code>{c.agentId}</code> (no verified console link format; search this ID)
        </dd>
        <dt className="text-muted-foreground">Cloned from</dt>
        <dd>
          {c.master ? (
            <>
              master <code>{c.master.agentId}</code>, committed version {c.master.version}
            </>
          ) : (
            "not recorded"
          )}
        </dd>
        <dt className="text-muted-foreground">Credential to select</dt>
        <dd>
          <code>{c.credentialName}</code> (name only, this customer's)
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          Waiting for tool credentials for {c.waitingLabel} (since {when(c.waitingSince)}).{" "}
          {c.resumeNote}
        </dd>
      </dl>
      {c.attention === "needs_intervention" ? (
        <p className="text-destructive" role="alert">
          {c.attentionNote}
        </p>
      ) : null}
      <table className="w-full text-left">
        <thead className="text-muted-foreground">
          <tr>
            <th className="pr-2">#</th>
            <th className="pr-2">Tool</th>
            <th className="pr-2">When it runs</th>
            <th className="pr-2">Expected authentication</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {c.tools.map((t) => (
            <tr key={t.name}>
              <td className="pr-2">{t.order}</td>
              <td className="pr-2">
                <code>{t.name}</code>
              </td>
              <td className="pr-2">{t.timing}</td>
              <td className="pr-2">{t.expectedAuth}</td>
              <td>
                {t.status === "missing"
                  ? "not reported created"
                  : "created, credential not yet confirmed"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ol className="list-decimal space-y-0.5 pl-5">
        {c.instructions.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <Button size="sm" variant="outline" onClick={() => onCopy(c.copyText)}>
        <Copy className="mr-1 size-3.5" /> Copy operator checklist
      </Button>
    </div>
  );
}

/**
 * Operator bridge: lets an admin's own Sarvam-signed-in MCP client build the
 * customers' agents from ClickAI work orders. ClickAI stores no Sarvam token.
 */
export function OperatorBridgePanel() {
  const status = useServerFn(getOperatorBridgeStatus);
  const issue = useServerFn(issueOperatorBridgeToken);
  const revoke = useServerFn(revokeOperatorBridgeTokens);
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["operator-bridge"],
    queryFn: () => status(),
    refetchInterval: 30_000,
  });
  const [issueOpen, setIssueOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [shown, setShown] = useState<{ token: string; expiresAt: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["operator-bridge"] });
  const command = (token: string) =>
    `claude mcp add --transport http clickai-operator ${data?.endpoint ?? "<ClickAI base URL>/api/public/operator/mcp"} --header "Authorization: Bearer ${token}"`;
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Could not copy"),
    );

  const awaiting = (data?.workOrders ?? []).filter((w) => w.checkpoint);
  const stale = awaiting.filter((w) => w.checkpoint!.attention === "needs_intervention").length;

  return (
    <SectionCard
      title="Agent builder (operator bridge)"
      description="Sarvam only allows agent authoring through a signed-in person, so ClickAI never holds a Sarvam token. Connect your own Sarvam-signed-in MCP client here and it builds waiting customers' agents; ClickAI then finishes deployment, number routing, verification and activation by itself."
    >
      {isLoading ? (
        <LoadingState label="Loading operator bridge" />
      ) : error ? (
        <ErrorState
          message={error instanceof Error ? error.message : "Could not load the bridge"}
          onRetry={() => void refetch()}
        />
      ) : (
        <div className="space-y-3 text-sm" data-testid="operator-bridge">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={data!.workOrders.length ? "ready" : "idle"}>
              {data!.workOrders.length} agent(s) waiting to be built
            </StatusPill>
            {awaiting.length ? (
              <StatusPill tone={stale ? "error" : "ready"}>
                {awaiting.length} awaiting tool credentials
                {stale ? `, ${stale} over 24 h` : ""}
              </StatusPill>
            ) : null}
            <StatusPill tone={data!.tokens.length ? "live" : "idle"}>
              {data!.tokens.length} active bridge token(s)
            </StatusPill>
            {!data!.endpoint ? (
              <span className="text-xs text-destructive">
                TELEPHONY_WEBHOOK_BASE_URL is not set
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="authoring-status">
            Unattended agent creation: <strong>not available yet</strong>. {data!.authoring.blocker}
          </p>
          {data!.workOrders.length ? (
            <ul className="divide-y divide-border text-xs" data-testid="work-orders">
              {data!.workOrders.map((w) => (
                <li key={w.workOrderId} className="flex flex-wrap items-center gap-2 py-1">
                  <Link
                    to="/admin/provisioning/$orgId"
                    params={{ orgId: w.customerId }}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {w.customer}
                  </Link>
                  <StatusPill tone={w.blocked ? "error" : "ready"}>
                    {w.blocked
                      ? "waiting for operator: Sarvam sign-in needed"
                      : w.stage === "needs_credential"
                        ? "waiting for agent credential"
                        : w.stage === "needs_tool_authentication"
                          ? "tools created: select credentials in the Sarvam console"
                          : "waiting for agent creation"}
                  </StatusPill>
                  <code className="text-muted-foreground">{w.agentId ?? w.agentName}</code>
                  {w.checkpoint ? (
                    <ToolAuthCheckpointCard checkpoint={w.checkpoint} onCopy={copy} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {data!.tokens.length ? (
            <ul className="text-xs text-muted-foreground">
              {data!.tokens.map((t) => (
                <li key={t.id}>
                  <code>{t.token_prefix}…</code> expires {when(t.expires_at)}
                  {t.last_used_at ? `, last used ${when(t.last_used_at)}` : ", unused"}
                </li>
              ))}
            </ul>
          ) : null}
          {shown ? (
            <div className="space-y-2 rounded-md border border-border bg-muted p-3" role="status">
              <p className="text-xs font-medium">
                Shown once. Expires {when(shown.expiresAt)}. Sign in to Sarvam in the same client (
                <code>/mcp</code> → sarvam-voice-agents → Authenticate; Sarvam signs you out after
                24 h), then ask it: "Process the pending ClickAI agent work orders."
              </p>
              <pre className="overflow-auto text-[11px]">{command(shown.token)}</pre>
              <Button size="sm" variant="outline" onClick={() => copy(command(shown.token))}>
                <Copy className="mr-1 size-3.5" /> Copy command
              </Button>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setIssueOpen(true)}>
              Create bridge token (8 h)
            </Button>
            {data!.tokens.length ? (
              <Button size="sm" variant="outline" onClick={() => setRevokeOpen(true)}>
                Revoke all
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <ReasonDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        title="Create an operator bridge token?"
        description="Gives your MCP client access to agent work orders for 8 hours. It can read the generated agent configuration for waiting customers and register the agents it builds. It cannot reach anything else."
        confirmLabel="Create token"
        onConfirm={async (reason) => {
          const out = await issue({ data: { hours: 8, reason } });
          setShown({ token: out.token, expiresAt: out.expiresAt });
          await refresh();
        }}
      />
      <ReasonDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Revoke all bridge tokens?"
        description="Connected MCP clients lose access immediately."
        confirmLabel="Revoke"
        onConfirm={async (reason) => {
          const out = await revoke({ data: { reason } });
          setShown(null);
          toast.success(`Revoked ${out.revoked} token(s)`);
          await refresh();
        }}
      />
    </SectionCard>
  );
}
