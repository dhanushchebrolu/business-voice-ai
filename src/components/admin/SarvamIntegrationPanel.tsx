import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  disableSarvamIntegration,
  getSarvamIntegration,
  issueSarvamIntegrationCredential,
  setSarvamTestCallers,
  testSarvamIntegration,
} from "@/lib/sarvam-integration.functions";
import { getSarvamAgentBrief } from "@/lib/sarvam-admin.functions";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";

const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "—");

/**
 * Connects a customer's manually created Sarvam agent to their ClickAI data:
 * a per-customer credential for the agent's HTTP tools, its status, a live
 * test, and exactly what to configure in Sarvam. The raw credential is shown
 * once, right after it is generated, and never again.
 */
export function SarvamIntegrationPanel({ orgId }: { orgId: string }) {
  const fetchIntegration = useServerFn(getSarvamIntegration);
  const issue = useServerFn(issueSarvamIntegrationCredential);
  const disable = useServerFn(disableSarvamIntegration);
  const runTest = useServerFn(testSarvamIntegration);
  const fetchBrief = useServerFn(getSarvamAgentBrief);
  const saveTestCallers = useServerFn(setSarvamTestCallers);
  const [testCallersOpen, setTestCallersOpen] = useState(false);
  const [testCallersText, setTestCallersText] = useState("");

  const [issueOpen, setIssueOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<Awaited<ReturnType<typeof runTest>> | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const state = useQuery({
    queryKey: ["admin-sarvam-integration", orgId],
    queryFn: () => fetchIntegration({ data: { orgId } }),
  });
  const brief = useQuery({
    queryKey: ["admin-sarvam-brief-tools", orgId],
    queryFn: () => fetchBrief({ data: { orgId } }),
    enabled: showConfig,
  });

  const integration = state.data?.integration ?? null;
  const expired =
    integration?.expires_at !== null &&
    integration?.expires_at !== undefined &&
    new Date(integration.expires_at).getTime() <= Date.now();
  const active = integration?.status === "active" && !expired;

  return (
    <SectionCard
      title="Sarvam agent data integration"
      description="Lets this customer's Sarvam agent read their live ClickAI business data (hours, services, prices, availability) and book appointments, authenticated with a credential that belongs only to this customer."
    >
      {state.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : state.error ? (
        <p className="text-sm text-destructive">{(state.error as Error).message}</p>
      ) : !state.data?.agent ? (
        <p className="text-sm text-muted-foreground">This customer has no agent yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusPill tone={active ? "live" : integration ? "error" : "idle"}>
              {active
                ? "Connected"
                : integration
                  ? expired
                    ? "Expired"
                    : "Disconnected"
                  : "Not connected"}
            </StatusPill>
            {integration ? (
              <span className="text-xs text-muted-foreground">
                Credential {integration.token_prefix}… · created {when(integration.created_at)}
                {integration.rotated_at ? ` · rotated ${when(integration.rotated_at)}` : ""} · last
                used {when(integration.last_used_at)}
                {integration.expires_at ? ` · expires ${when(integration.expires_at)}` : ""}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Sarvam app: {state.data.agent.sarvamAppId ?? "not mapped"}
            {state.data.agent.sarvamAppVersion ? ` v${state.data.agent.sarvamAppVersion}` : ""}
          </p>
          {integration ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Test callers (bookings not saved, no leads):{" "}
              {integration.test_caller_numbers.length
                ? integration.test_caller_numbers.join(", ")
                : "none"}
            </p>
          ) : null}

          {newToken ? (
            <div className="mt-3 space-y-2 rounded-md border border-amber-500/60 p-3">
              <p className="text-sm font-medium">
                Copy this credential now. It will not be shown again.
              </p>
              <code className="block break-all rounded bg-muted p-2 text-xs">{newToken}</code>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(newToken);
                    toast.success("Credential copied");
                  }}
                >
                  Copy
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNewToken(null)}>
                  I've saved it in Sarvam
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                In Sarvam, store it as a secret and use it as the Bearer token of every ClickAI tool
                on this customer's agent.
              </p>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setIssueOpen(true)}>
              {integration?.status === "active" ? "Rotate credential" : "Generate credential"}
            </Button>
            {integration?.status === "active" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setTestCallersText(integration.test_caller_numbers.join(", "));
                  setTestCallersOpen(true);
                }}
              >
                Test callers
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  setTest(await runTest({ data: { orgId } }));
                } catch (err) {
                  toast.error((err as Error).message);
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? "Testing…" : "Test integration"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowConfig((v) => !v)}>
              {showConfig ? "Hide Sarvam configuration" : "Sarvam configuration"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={integration?.status !== "active"}
              onClick={() => setDisableOpen(true)}
            >
              Disconnect
            </Button>
          </div>

          {test ? (
            <div className="mt-3 space-y-1 rounded-md border border-border p-3 text-xs">
              <p>
                Endpoint:{" "}
                {test.endpoint.url
                  ? `${test.endpoint.url} answered ${test.endpoint.status ?? "no response"}${test.endpoint.rejectsMissingToken ? " (rejects a missing credential, as it should)" : " — expected 401"}`
                  : "TELEPHONY_WEBHOOK_BASE_URL is not set"}
              </p>
              <p>
                What the agent receives now: <strong>{test.contextStatus}</strong>
                {test.variables?.["missing"] ? ` · missing: ${test.variables["missing"]}` : ""}
              </p>
              {test.variables ? (
                <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-0.5">
                  {Object.entries(test.variables)
                    .filter(([k]) => k !== "guidance")
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="font-mono text-muted-foreground">{k}</dt>
                        <dd className="break-words">{v || "—"}</dd>
                      </div>
                    ))}
                </dl>
              ) : null}
            </div>
          ) : null}

          {showConfig ? (
            <div className="mt-3 space-y-3 rounded-md border border-border p-3 text-xs">
              {brief.isLoading ? (
                <p className="text-muted-foreground">Loading…</p>
              ) : !brief.data?.toolConfiguration ? (
                <p className="text-destructive">
                  TELEPHONY_WEBHOOK_BASE_URL is not set on this server.
                </p>
              ) : (
                <>
                  <p>
                    Create these HTTP API tools on this customer's Sarvam agent. Auth: Bearer token
                    from the Sarvam secret holding this customer's credential. Sarvam's requests
                    come from {brief.data.toolConfiguration.allowlistIps.join(", ")} (only relevant
                    if inbound traffic is ever IP-restricted).
                  </p>
                  {brief.data.toolConfiguration.tools.map((t) => (
                    <div key={t.name} className="space-y-1 border-t border-border pt-2">
                      <p className="font-medium">
                        {t.name} · lifecycle {t.lifecycle} · {t.method}
                      </p>
                      <p className="break-all font-mono">{t.url}</p>
                      <p className="text-muted-foreground">{t.purpose}</p>
                      <pre className="whitespace-pre-wrap rounded bg-muted p-2">
                        {JSON.stringify(t.body, null, 2)}
                      </pre>
                      {t.saveIntoVariables ? (
                        <p>Save reply into variables: {t.saveIntoVariables.join(", ")}</p>
                      ) : null}
                    </div>
                  ))}
                  <div className="border-t border-border pt-2">
                    <p className="font-medium">
                      Input variables (create before the tools; default value in brackets)
                    </p>
                    <p className="font-mono">
                      {brief.data.toolConfiguration.inputVariables
                        .map((v) => `${v.name} [${v.defaultValue}]`)
                        .join(", ")}
                    </p>
                  </div>
                  <div className="border-t border-border pt-2">
                    <p className="font-medium">Output variables (used by record_call_outcome)</p>
                    {brief.data.toolConfiguration.outputVariables.map((v) => (
                      <p key={v.name}>
                        <span className="font-mono">{v.name}</span> · {v.type} ·{" "}
                        {v.extractionPrompt}
                      </p>
                    ))}
                  </div>
                  <div className="border-t border-border pt-2">
                    <p className="font-medium">Add to the agent's instructions</p>
                    <p className="rounded bg-muted p-2">
                      {brief.data.toolConfiguration.promptGuard}
                    </p>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {(state.data.recentEvents ?? []).length > 0 ? (
            <div className="mt-3 border-t border-border pt-2">
              <p className="text-xs font-medium">Recent requests from Sarvam</p>
              <ul className="text-xs text-muted-foreground">
                {state.data.recentEvents.map((e, i) => (
                  <li key={i}>
                    {when(e.created_at)} · {e.kind} · {e.status}
                    {e.interaction_id ? ` · ${e.interaction_id}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}

      <ReasonDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        title={integration?.status === "active" ? "Rotate credential" : "Generate credential"}
        description={
          integration?.status === "active"
            ? "Issues a new credential. The current one stops working immediately, so update the Sarvam secret right away."
            : "Issues this customer's credential for their Sarvam agent's ClickAI tools. It is shown once."
        }
        confirmLabel={integration?.status === "active" ? "Rotate" : "Generate"}
        onConfirm={async (reason) => {
          const r = await issue({ data: { orgId, reason } });
          setNewToken(r.token);
          void state.refetch();
        }}
      />
      <ReasonDialog
        open={testCallersOpen}
        onOpenChange={setTestCallersOpen}
        title="Test callers"
        description="Calls from these numbers are tests: the agent checks the slot but never saves a booking, and no lead is created. Use the country code, e.g. +919876543210. Separate numbers with commas; leave empty to remove all."
        confirmLabel="Save"
        extra={
          <input
            aria-label="Test caller numbers"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={testCallersText}
            onChange={(e) => setTestCallersText(e.target.value)}
            placeholder="+919876543210, +919812345678"
          />
        }
        onConfirm={async (reason) => {
          const numbers = testCallersText
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean);
          const r = await saveTestCallers({ data: { orgId, numbers, reason } });
          toast.success(`Test callers saved (${r.numbers.length})`);
          void state.refetch();
        }}
      />
      <ReasonDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Disconnect integration"
        description="The credential stops working immediately; the Sarvam agent can no longer read this customer's data or book. Calls and deployments are not affected."
        confirmLabel="Disconnect"
        onConfirm={async (reason) => {
          await disable({ data: { orgId, reason } });
          toast.success("Integration disconnected");
          void state.refetch();
        }}
      />
    </SectionCard>
  );
}
