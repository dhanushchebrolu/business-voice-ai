import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Copy } from "lucide-react";
import { toast } from "sonner";
import {
  clearAdmissionBlock,
  confirmSarvamNumber,
  reverifyLiveDeployment,
  updateSarvamWebhookToken,
  resumeSarvamDeploymentAfterTokenUpdate,
  getProvisioningDetail,
  registerCustomerSarvamAgent,
} from "@/lib/provisioning-admin.functions";
import { retryProvisioning } from "@/lib/telephony-admin.functions";
import {
  activationGate,
  provisioningChecklist,
  queueStatus,
  queueStatusTone,
  type ChecklistInput,
} from "@/lib/provisioning-view";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusPill,
} from "@/components/app/primitives";
import { SarvamIntegrationPanel } from "@/components/admin/SarvamIntegrationPanel";
import { VoiceLanguagePanel } from "@/components/admin/VoiceLanguagePanel";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/provisioning/$orgId")({
  component: ProvisioningDetail,
});

const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "—");

function copy(text: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success("Copied"))
    .catch(() => toast.error("Could not copy"));
}

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1 text-xs"
      onClick={() => copy(value)}
      aria-label={`Copy ${label}`}
    >
      <Copy className="size-3" /> Copy
    </Button>
  );
}

function ProvisioningDetail() {
  const { orgId } = Route.useParams();
  const qc = useQueryClient();
  const fetchDetail = useServerFn(getProvisioningDetail);
  const register = useServerFn(registerCustomerSarvamAgent);
  const retry = useServerFn(retryProvisioning);
  const confirmNumber = useServerFn(confirmSarvamNumber);
  const clearBlock = useServerFn(clearAdmissionBlock);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [reverifyOpen, setReverifyOpen] = useState(false);
  const reverifyLive = useServerFn(reverifyLiveDeployment);
  const updateWebhookToken = useServerFn(updateSarvamWebhookToken);
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const resumeAfterUpdate = useServerFn(resumeSarvamDeploymentAfterTokenUpdate);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [appVersion, setAppVersion] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-provisioning-detail", orgId],
    queryFn: () => fetchDetail({ data: { orgId } }),
  });
  // Registering also marks voice & language applied, so the panel's status must refresh too.
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["admin-provisioning-detail", orgId] }),
      qc.invalidateQueries({ queryKey: ["admin-voice-language", orgId] }),
    ]);

  if (isLoading) return <LoadingState label="Loading provisioning" />;
  if (error || !data)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load"}
        onRetry={() => void refetch()}
      />
    );

  const gateInput: ChecklistInput = { ...data.gateInput, now: new Date(data.gateInput.now) };
  const checklist = provisioningChecklist(gateInput);
  const activation = activationGate(gateInput);
  const latest = data.runs[0] ?? null;
  // A failure before verification (e.g. deployment creation) must be explained here too,
  // not only in the job history (found in browser testing).
  const latestFailure = latest?.status === "failed" ? (latest.last_error ?? latest.note) : null;
  const verification = (data.runs.find((r) => r.verification)?.verification ?? null) as {
    deploymentId: string;
    expected: { appId: string; appVersion: number; number: string };
    actual: {
      appId: string;
      appVersion: number | null;
      status: string | null;
      phoneNumbers: string[];
      clickaiDeploymentId: string | null;
    };
    checks: { id: string; label: string; ok: boolean; detail: string }[];
  } | null;
  const configJson = data.config ? JSON.stringify(data.config.tools, null, 2) : "";

  return (
    <div className="space-y-6">
      <Link
        to="/admin/provisioning"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-4" /> Provisioning
      </Link>
      <PageHeader
        title={data.org.name}
        description={`${data.org.client_id ?? ""} · ${data.business ? data.business.business_type.replace(/_/g, " ") : "no business profile"} · lifecycle ${data.org.lifecycle_status}`}
        actions={
          latest ? (
            <StatusPill tone={queueStatusTone(queueStatus(latest))}>
              {queueStatus(latest)}
            </StatusPill>
          ) : null
        }
      />

      <SectionCard
        title="Checklist"
        description="Steps 5 and 6 are done by the ClickAI team in the Sarvam console; there is no API for them."
      >
        <ol className="space-y-1.5 text-sm" data-testid="provisioning-checklist">
          {checklist.map((c) => (
            <li key={c.step} className="flex flex-wrap items-baseline gap-2">
              <StatusPill
                tone={c.status === "done" ? "live" : c.status === "todo" ? "idle" : "error"}
              >
                {c.status}
              </StatusPill>
              <span className="font-medium">
                {c.step}. {c.label}
                {c.manual ? " (manual, Sarvam console)" : ""}
              </span>
              <span className="text-xs text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard
        title="Number"
        description="The customer's pre-assigned Sarvam number. Numbers are assigned on the Phone numbers page; nothing here rents, buys or claims one."
      >
        {data.numbers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No number assigned.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.numbers.map((n) => {
              const admitted =
                data.numbers.filter((x) => x.provider === "sarvam").length === 1 &&
                n.status === "active" &&
                n.inbound_enabled &&
                Boolean(n.provider_deployment_id) &&
                n.verified_deployment_id === n.provider_deployment_id &&
                n.verified_sarvam_app_id === data.agent?.sarvam_app_id &&
                n.verified_sarvam_app_version === data.agent?.sarvam_app_version &&
                !n.admission_blocked_at;
              return (
                <li key={n.id} className="space-y-0.5">
                  <div className="flex flex-wrap gap-2">
                    <span className="font-mono">{n.e164}</span>
                    <StatusPill tone={n.status === "active" ? "live" : "idle"}>
                      {n.status}
                    </StatusPill>
                    <StatusPill tone={admitted ? "live" : "error"}>
                      {admitted ? "business data served" : "business data blocked"}
                    </StatusPill>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {n.provider} · inbound {n.inbound_enabled ? "on" : "off"} · deployment{" "}
                    {n.provider_deployment_id ?? "none"} · connection{" "}
                    {n.connection_id ? "linked" : "not linked"}
                  </div>
                  <div className="text-xs text-muted-foreground" data-testid="number-verification">
                    In Sarvam:{" "}
                    {n.sarvam_number_confirmed_at
                      ? `confirmed ${when(n.sarvam_number_confirmed_at)}`
                      : "not confirmed"}{" "}
                    · verified mapping:{" "}
                    {n.verified_deployment_id
                      ? `${n.verified_deployment_id} → ${n.verified_sarvam_app_id} v${n.verified_sarvam_app_version} (${when(n.deployment_verified_at)})`
                      : "none"}
                  </div>
                  {n.admission_blocked_at ? (
                    <div className="text-xs text-destructive" role="alert">
                      Blocked {when(n.admission_blocked_at)}: {n.admission_blocked_reason}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {data.numbers.some((n) => !n.sarvam_number_confirmed_at && !n.provider_deployment_id) ? (
            <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
              Confirm number exists in Sarvam
            </Button>
          ) : null}
          {data.numbers.some((n) => n.admission_blocked_at) ? (
            <Button size="sm" variant="outline" onClick={() => setClearOpen(true)}>
              Clear admission block
            </Button>
          ) : null}
          {data.numbers.some(
            (n) => n.status === "active" && n.inbound_enabled && n.provider_deployment_id,
          ) ? (
            <Button size="sm" variant="outline" onClick={() => setReverifyOpen(true)}>
              Re-verify live deployment
            </Button>
          ) : null}
          {data.numbers.some((n) => n.provider === "sarvam" && n.provider_deployment_id) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setConfirmPause(false);
                setWebhookOpen(true);
              }}
            >
              Update webhook token in Sarvam
            </Button>
          ) : null}
        </div>
        {data.webhookRecovery ? (
          <div
            role="alert"
            data-testid="webhook-recovery"
            className="mt-2 rounded-md border border-destructive/40 p-2 text-xs text-destructive"
          >
            <p>
              Recovery required: a webhook-token update left deployment{" "}
              {data.webhookRecovery.deploymentId} out of its original state (
              {data.webhookRecovery.originalStatus}). It may not be answering calls. No further
              token update is allowed until it is resumed.
            </p>
            <Button
              size="sm"
              variant="destructive"
              className="mt-2"
              onClick={() => setResumeOpen(true)}
            >
              Resume deployment
            </Button>
          </div>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          Sarvam connection:{" "}
          {data.connection?.registered
            ? `registered${data.connection.label ? ` (${data.connection.label})` : ""}`
            : "not registered"}
        </p>
      </SectionCard>

      <SectionCard
        title="Generated agent configuration"
        description="Apply this to the customer's copy of the universal master agent."
      >
        {!data.config ? (
          <p className="text-sm text-muted-foreground">The customer has not finished onboarding.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span>Fingerprint</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {data.config.fingerprint}
              </code>
              <CopyButton value={data.config.fingerprint} label="fingerprint" />
              {latest?.agent_config_fingerprint &&
              latest.agent_config_fingerprint !== data.config.fingerprint ? (
                <StatusPill tone="error">changed since the last run</StatusPill>
              ) : null}
            </div>
            <ul className="space-y-1">
              {data.config.capabilities.map((c) => (
                <li key={c.id} className="flex flex-wrap gap-2">
                  <StatusPill tone={!c.enabled ? "idle" : c.missing.length ? "error" : "live"}>
                    {c.enabled ? "on" : "off"}
                  </StatusPill>
                  <span>{c.label}</span>
                  {c.missing.length ? (
                    <span className="text-xs text-destructive">needs {c.missing.join(", ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            {data.config.blockers.length ? (
              <div
                className="rounded border border-destructive/40 p-2 text-xs text-destructive"
                role="alert"
              >
                Missing onboarding requirements: {data.config.blockers.join(" ")}
              </div>
            ) : null}
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">Tools to switch on / off</span>
                <CopyButton value={configJson} label="tool configuration" />
              </div>
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 text-xs">
                {configJson}
              </pre>
            </div>
            {data.config.callTransferNumber ? (
              <div className="flex items-center gap-2">
                <span>Call transfer number</span>
                <code className="text-xs">{data.config.callTransferNumber}</code>
                <CopyButton value={data.config.callTransferNumber} label="transfer number" />
              </div>
            ) : null}
            <div data-testid="voice-language-config">
              <span className="font-medium">Voice & languages</span>
              {data.config.voiceLanguage ? (
                <div className="mt-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span>
                      {data.config.voiceLanguage.voice.name} · starts in{" "}
                      {data.config.voiceLanguage.defaultLanguage} · languages{" "}
                      {data.config.voiceLanguage.allowedLanguages.join(", ")} · auto-switch{" "}
                      {data.config.voiceLanguage.autoLanguageSwitch ? "on" : "off"}
                    </span>
                    <StatusPill tone={data.voiceLanguage?.status === "applied" ? "live" : "ready"}>
                      {data.voiceLanguage?.status === "applied"
                        ? `applied in v${data.voiceLanguage.applied_sarvam_app_version}`
                        : "not yet applied"}
                    </StatusPill>
                    <CopyButton
                      value={JSON.stringify(data.config.voiceLanguage.sarvamConfig, null, 2)}
                      label="voice and language configuration"
                    />
                  </div>
                  {data.config.voiceLanguage.warnings.map((w) => (
                    <p key={w} className="text-xs text-muted-foreground">
                      {w}
                    </p>
                  ))}
                  <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(data.config.voiceLanguage.sarvamConfig, null, 2)}
                  </pre>
                </div>
              ) : (
                <p className="mt-1 text-xs text-destructive" role="alert">
                  {data.config.voiceLanguageProblem} Set them in Voice & language below.
                </p>
              )}
            </div>
          </div>
        )}
      </SectionCard>

      <VoiceLanguagePanel orgId={orgId} />

      <SarvamIntegrationPanel orgId={orgId} />

      <SectionCard
        title="Manual Sarvam setup"
        description="Sarvam has no API to create or configure agents, so these steps are done by hand."
      >
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>
            In the Sarvam console, copy the universal master agent and name it after this customer.
          </li>
          <li>Switch tools on and off exactly as listed in the generated configuration above.</li>
          <li>
            Store this customer's integration credential as the Sarvam secret used by the ClickAI
            tools.
          </li>
          {data.config?.callTransferNumber ? (
            <li>Set call transfer to {data.config.callTransferNumber}.</li>
          ) : null}
          <li>
            {data.config?.voiceLanguage
              ? `Apply the voice & language configuration above (voice ${data.config.voiceLanguage.voice.name}, starting in ${data.config.voiceLanguage.defaultLanguage}), then commit a version.`
              : "Save this customer's voice & languages first, apply them, then commit a version."}
          </li>
          <li>Register the copied agent's id and committed version below.</li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span>Registered:</span>
          <code className="text-xs">
            {data.agent?.sarvam_app_id
              ? `${data.agent.sarvam_app_id} v${data.agent.sarvam_app_version}`
              : "none"}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRegisterOpen(true)}
            disabled={!data.agent}
          >
            Register Sarvam agent
          </Button>
        </div>
        {!data.masterAgentConfigured ? (
          <p className="mt-2 text-xs text-muted-foreground">
            SARVAM_MASTER_AGENT_APP_ID is not set on this server, so the master-agent check relies
            on the admin.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Deployment and verification"
        description="Verification reads the deployment from Sarvam and compares it with what ClickAI expects. A new deployment is paused until every check passes; Sarvam creates deployments active, so for a few seconds after creation calls can still reach the agent, which then gets no ClickAI business data."
      >
        {verification ? (
          <div className="space-y-2 text-sm">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th />
                  <th>Expected</th>
                  <th>Actual</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Agent</td>
                  <td>
                    {verification.expected.appId} v{verification.expected.appVersion}
                  </td>
                  <td>
                    {verification.actual.appId} v{verification.actual.appVersion ?? "?"}
                  </td>
                </tr>
                <tr>
                  <td>Number</td>
                  <td>{verification.expected.number}</td>
                  <td>{verification.actual.phoneNumbers.join(", ") || "none"}</td>
                </tr>
                <tr>
                  <td>Deployment</td>
                  <td>{verification.deploymentId}</td>
                  <td>
                    {verification.actual.clickaiDeploymentId ?? "none"} (
                    {verification.actual.status ?? "unknown"})
                  </td>
                </tr>
              </tbody>
            </table>
            <ul className="space-y-1">
              {verification.checks.map((c) => (
                <li key={c.id} className="flex flex-wrap gap-2">
                  <StatusPill tone={c.ok ? "live" : "error"}>{c.ok ? "pass" : "fail"}</StatusPill>
                  <span>{c.label}</span>
                  {!c.ok ? <span className="text-xs text-destructive">{c.detail}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Not verified yet.</p>
        )}
        {latestFailure ? (
          <p className="mt-2 text-xs text-destructive" role="alert" data-testid="latest-run-error">
            Last attempt failed: {latestFailure}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!activation.allowed} onClick={() => setRunOpen(true)}>
            Create / verify deployment and activate
          </Button>
          {!activation.allowed ? (
            <span className="text-xs text-muted-foreground">{activation.reasons.join(" ")}</span>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Audit history"
        description="Latest 30 administrative actions for this customer."
      >
        {data.audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audited actions yet.</p>
        ) : (
          <ul className="divide-y divide-border text-xs" data-testid="audit-history">
            {data.audit.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2 py-1.5">
                <span className="font-medium">{a.action}</span>
                <span className="text-muted-foreground">{when(a.created_at)}</span>
                <span className="text-muted-foreground">{a.admin_email ?? "system"}</span>
                {a.reason ? <span>{a.reason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Job history"
        description="Latest 20 runs. Retrying resumes the active run; it never creates a second deployment or assigns another number."
      >
        {data.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-border text-xs">
            {data.runs.map((r) => (
              <li key={r.id} className="space-y-0.5 py-1.5">
                <div className="flex flex-wrap gap-2">
                  <StatusPill tone={queueStatusTone(queueStatus(r))}>{queueStatus(r)}</StatusPill>
                  <span>{r.trigger}</span>
                  <span>step {r.current_step ?? "—"}</span>
                  <span>{r.attempts} attempt(s)</span>
                  <span className="text-muted-foreground">
                    {when(r.created_at)} → {when(r.finished_at ?? r.updated_at)}
                  </span>
                </div>
                {r.note ? <div className="text-muted-foreground">{r.note}</div> : null}
                {r.last_error ? <div className="text-destructive">{r.last_error}</div> : null}
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="outline" className="mt-2" onClick={() => setRunOpen(true)}>
          Retry provisioning
        </Button>
      </SectionCard>

      <ReasonDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        title="Register the customer's Sarvam agent"
        description="Only the customer's own copy of the master agent, after the configuration, credential and the saved voice & languages are applied and a version is committed. Registering records that this version carries those voice & language settings."
        extra={
          <div className="space-y-2">
            <Input
              aria-label="Sarvam agent id"
              placeholder="Sarvam agent id"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
            <Input
              aria-label="Committed version"
              inputMode="numeric"
              placeholder="Committed version"
              value={appVersion}
              onChange={(e) => setAppVersion(e.target.value)}
            />
          </div>
        }
        onConfirm={async (reason) => {
          await register({
            data: {
              orgId,
              sarvamAppId: appId.trim(),
              sarvamAppVersion: Number(appVersion),
              reason,
            },
          });
          toast.success("Sarvam agent registered.");
          await refresh();
        }}
      />
      <ReasonDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        title="Run provisioning"
        description="Resumes this customer's provisioning job: creates or adopts the deployment, verifies it with Sarvam and activates the number only if every check passes."
        onConfirm={async (reason) => {
          const r = await retry({ data: { orgId, reason } });
          if (r.state === "active") toast.success("Number is live.");
          else toast.message(r.note);
          await refresh();
        }}
      />
      <ReasonDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Confirm the number exists in Sarvam"
        description="Check in the Sarvam console (Phone numbers) that this exact number is already there on this customer's connection. ClickAI cannot check this itself and never rents, buys or claims numbers."
        onConfirm={async (reason) => {
          await confirmNumber({ data: { orgId, reason } });
          toast.success("Number confirmed.");
          await refresh();
        }}
      />
      <ReasonDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="Clear the admission block"
        description="Only after you have checked in Sarvam which deployment handled the call and removed or fixed any deployment ClickAI did not create. Business data is still served only to an ACTIVE, verified number."
        onConfirm={async (reason) => {
          await clearBlock({ data: { orgId, reason } });
          toast.success("Block cleared.");
          await refresh();
        }}
      />
      <ReasonDialog
        open={reverifyOpen}
        onOpenChange={setReverifyOpen}
        title="Re-verify the live deployment"
        description="Reads this customer's deployment from Sarvam (no changes there) and checks deployment, agent, version, number and status. Saves the verified mapping only if every check passes; a mismatch blocks business data until fixed."
        onConfirm={async (reason) => {
          const r = await reverifyLive({ data: { orgId, reason } });
          if (r.outcome === "verified") toast.success(r.detail);
          else toast.error(r.detail);
          await refresh();
        }}
      />
      <ReasonDialog
        open={webhookOpen}
        onOpenChange={setWebhookOpen}
        title="Update the webhook token in Sarvam"
        description="For rotating the Sarvam webhook secret only (see docs/sarvam-webhook-token-rotation.md). Replaces this customer's deployment webhook with one carrying the current token, then reads it back. Sarvam edits only paused deployments, so an active deployment is paused for a few seconds and resumed: calls to this number are not answered during that time."
        extra={
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmPause}
              onChange={(e) => setConfirmPause(e.target.checked)}
              aria-label="I understand the deployment may be paused for a few seconds"
            />
            <span>
              I understand an active deployment will be paused for a few seconds and resumed.
            </span>
          </label>
        }
        onConfirm={async (reason) => {
          const r = await updateWebhookToken({ data: { orgId, reason, confirmPause } });
          // Only a verified read-back counts as success; recovery_required is an error.
          if (r.outcome === "rotated" || r.outcome === "already_current") toast.success(r.detail);
          else toast.error(r.detail);
          await refresh();
        }}
      />
      <ReasonDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title="Resume the deployment"
        description="Recovery after a failed webhook-token update: resumes this customer's deployment back to active, its original state, only if Sarvam still shows the same agent, version and number. Nothing else is changed."
        onConfirm={async (reason) => {
          const r = await resumeAfterUpdate({ data: { orgId, reason } });
          if (r.outcome === "resumed" || r.outcome === "already_resumed") toast.success(r.detail);
          else toast.error(r.detail);
          await refresh();
        }}
      />
    </div>
  );
}
