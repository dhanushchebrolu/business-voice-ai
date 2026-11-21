import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  disableSarvamIntegration,
  issueSarvamIntegrationCredential,
} from "@/lib/sarvam-integration.functions";
import { registerCustomerSarvamOutboundAgent } from "@/lib/provisioning-admin.functions";
import { OUTBOUND_AGENT_TOOLS, OUTBOUND_FORBIDDEN_TOOLS } from "@/lib/agent-roles";
import {
  credentialLive,
  outboundRegistrationGate,
  type OutboundChecklistInput,
} from "@/lib/provisioning-view";
import type { SarvamToolConfiguration } from "@/lib/sarvam-agent-api.server";
import type { OutboundAgentConfig } from "@/lib/universal-agent-config";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "—");

function copyText(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`))
    .catch(() => toast.error("Could not copy"));
}

export interface OutboundAgentPanelProps {
  orgId: string;
  gate: OutboundChecklistInput;
  credential: {
    status: string;
    token_prefix: string;
    created_at: string;
    rotated_at: string | null;
    last_used_at: string | null;
    expires_at: string | null;
  } | null;
  config: OutboundAgentConfig | null;
  template: SarvamToolConfiguration | null;
  registeredAt: string | null;
  onChanged: () => Promise<unknown>;
}

/**
 * The customer's OUTBOUND agent (agent-roles.ts): its own credential, the
 * outbound template to build in Sarvam (only the allowed tools), and the
 * registration of the agent the operator created. Every rule shown here is
 * enforced again on the server; registering never switches outbound calling on.
 */
export function OutboundAgentPanel(p: OutboundAgentPanelProps) {
  const issue = useServerFn(issueSarvamIntegrationCredential);
  const disable = useServerFn(disableSarvamIntegration);
  const register = useServerFn(registerCustomerSarvamOutboundAgent);
  const [issueOpen, setIssueOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [appId, setAppId] = useState("");
  const [appVersion, setAppVersion] = useState("");

  const live = credentialLive(
    p.credential ? { status: p.credential.status, expiresAt: p.credential.expires_at } : null,
    p.gate.now,
  );
  const gate = outboundRegistrationGate(p.gate, appId);
  const templateJson = p.template ? JSON.stringify(p.template, null, 2) : "";
  const systemPrompt = p.template?.systemPrompt ?? "";
  const replyTemplates = (p.template?.tools ?? []).filter((t) => t.responseTemplate);

  return (
    <SectionCard
      title="Outbound agent"
      description="A second, separate Sarvam agent that ClickAI dials for outbound calls. It can read business data, check availability, book a free time for the person ClickAI called, and record the call's outcome; it can never arrange callbacks, send reminders or transfer calls. ClickAI refuses those for its credential, and books only for the number it dialled, even if the agent is misconfigured."
    >
      <div className="space-y-4 text-sm" data-testid="outbound-agent-panel">
        <div>
          <p className="font-medium">1. Outbound credential</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusPill tone={live ? "live" : p.credential ? "error" : "idle"}>
              {live ? "Active" : p.credential ? "Inactive" : "Not issued"}
            </StatusPill>
            {p.credential ? (
              <span className="text-xs text-muted-foreground">
                {p.credential.token_prefix}… · created {when(p.credential.created_at)}
                {p.credential.rotated_at ? ` · rotated ${when(p.credential.rotated_at)}` : ""} ·
                last used {when(p.credential.last_used_at)}
              </span>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setIssueOpen(true)}>
              {live ? "Rotate outbound credential" : "Generate outbound credential"}
            </Button>
            {live ? (
              <Button size="sm" variant="outline" onClick={() => setDisableOpen(true)}>
                Disconnect outbound credential
              </Button>
            ) : null}
          </div>
          {newToken ? (
            <div
              className="mt-2 space-y-2 rounded-md border border-amber-500/60 p-3"
              data-testid="outbound-new-token"
            >
              <p className="font-medium">
                Copy this OUTBOUND credential now. It will not be shown again.
              </p>
              <code className="block break-all rounded bg-muted p-2 text-xs">{newToken}</code>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyText(newToken, "Credential")}
                >
                  Copy
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNewToken(null)}>
                  I've saved it on the outbound agent
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Store it only as the secret of the outbound agent's ClickAI tools. Never put it on
                the inbound agent, and never put the inbound credential on the outbound agent.
              </p>
            </div>
          ) : null}
        </div>

        <div>
          <p className="font-medium">2. Create the outbound agent in Sarvam (manual)</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-xs">
            <li>
              Create a new agent (or copy the outbound master template) named after this customer
              plus "outbound". Do not copy or reuse the inbound agent.
            </li>
            <li>
              Tools: only <span className="font-mono">{OUTBOUND_AGENT_TOOLS.join(", ")}</span>.
              Never add <span className="font-mono">{OUTBOUND_FORBIDDEN_TOOLS.join(", ")}</span>.
            </li>
            <li>
              Declare the variables{" "}
              <span className="font-mono">
                {(p.config?.callVariables ?? []).join(", ") || "call_direction, clickai_call_id"}
              </span>{" "}
              and the business-data variables listed in the template.
            </li>
            <li>Use the outbound credential above as the Bearer token of every ClickAI tool.</li>
            <li>
              Paste the generated system prompt below as the agent's instructions, unchanged. It is
              the same for every customer; the business's details reach it as variables.
            </li>
            <li>
              On check_availability and book_appointment, paste each reply template below as the
              tool's reply (send fields from the API response to the agent), unchanged.
            </li>
            <li>
              {p.config?.voiceLanguage
                ? `Same voice and languages as the inbound agent (voice ${p.config.voiceLanguage.voice.name}, starting in ${p.config.voiceLanguage.defaultLanguage}).`
                : "Save this customer's voice & languages first."}{" "}
              Set the maximum call length, then commit a version.
            </li>
          </ol>
          {p.template ? (
            <div className="mt-2 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Outbound template {p.config ? `(fingerprint ${p.config.fingerprint})` : ""}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => copyText(templateJson, "Outbound template")}
                >
                  Copy outbound template
                </Button>
              </div>
              <pre
                className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs"
                data-testid="outbound-template"
              >
                {templateJson}
              </pre>
              {systemPrompt ? (
                <>
                  <div className="flex items-center gap-2 pt-2">
                    <span className="text-xs text-muted-foreground">Outbound system prompt</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => copyText(systemPrompt, "Outbound system prompt")}
                    >
                      Copy system prompt
                    </Button>
                  </div>
                  <pre
                    className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs"
                    data-testid="outbound-system-prompt"
                  >
                    {systemPrompt}
                  </pre>
                </>
              ) : null}
              {replyTemplates.map((t) => (
                <div key={t.name}>
                  <div className="flex items-center gap-2 pt-2">
                    <span className="text-xs text-muted-foreground">{t.name} reply template</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => copyText(t.responseTemplate ?? "", `${t.name} reply template`)}
                    >
                      Copy reply template
                    </Button>
                  </div>
                  <pre
                    className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs"
                    data-testid={`outbound-reply-template-${t.name}`}
                  >
                    {t.responseTemplate}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-destructive">
              TELEPHONY_WEBHOOK_BASE_URL is not set on this server, so the template cannot be
              generated.
            </p>
          )}
        </div>

        <div>
          <p className="font-medium">3. Register the outbound agent</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span>Registered:</span>
            <code className="text-xs" data-testid="outbound-registered">
              {p.gate.appId ? `${p.gate.appId} v${p.gate.appVersion}` : "none"}
            </code>
            {p.registeredAt ? (
              <span className="text-xs text-muted-foreground">on {when(p.registeredAt)}</span>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setRegisterOpen(true)}>
              Register outbound agent
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Registering never switches outbound calling on. ClickAI dials only this agent, only in a
            version confirmed after a supervised call, and never the inbound agent.
          </p>
        </div>
      </div>

      <ReasonDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        title={live ? "Rotate outbound credential" : "Generate outbound credential"}
        description={
          live
            ? "Issues a new outbound credential. The current one stops working immediately, so update the outbound agent's Sarvam secret right away. The inbound credential is not affected."
            : "Issues the credential for this customer's OUTBOUND agent. It is shown once. It can only read business data, check availability and record call outcomes."
        }
        confirmLabel={live ? "Rotate" : "Generate"}
        onConfirm={async (reason) => {
          const r = await issue({ data: { orgId: p.orgId, reason, role: "outbound" } });
          setNewToken(r.token);
          await p.onChanged();
        }}
      />
      <ReasonDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Disconnect outbound credential"
        description="The outbound agent's credential stops working immediately. The inbound agent and its credential are not affected."
        confirmLabel="Disconnect"
        onConfirm={async (reason) => {
          await disable({ data: { orgId: p.orgId, reason, role: "outbound" } });
          toast.success("Outbound credential disconnected");
          await p.onChanged();
        }}
      />
      <ReasonDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        title="Register the customer's outbound agent"
        description="Only the customer's own outbound agent, built from the outbound template with the outbound credential, after a version is committed. Not the inbound agent and not a master template."
        extra={
          <div className="space-y-2">
            <Input
              aria-label="Outbound Sarvam agent id"
              placeholder="Outbound Sarvam agent id"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
            <Input
              aria-label="Outbound committed version"
              inputMode="numeric"
              placeholder="Committed version"
              value={appVersion}
              onChange={(e) => setAppVersion(e.target.value)}
            />
            {appId.trim() && !gate.allowed ? (
              <ul className="text-xs text-destructive" data-testid="outbound-register-blockers">
                {gate.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
        }
        onConfirm={async (reason) => {
          const r = await register({
            data: {
              orgId: p.orgId,
              sarvamAppId: appId.trim(),
              sarvamAppVersion: Number(appVersion),
              reason,
            },
          });
          toast.success(
            r.outboundConfirmationCleared
              ? "Outbound agent registered. Outbound calling needs to be confirmed again for this version."
              : "Outbound agent registered.",
          );
          await p.onChanged();
        }}
      />
    </SectionCard>
  );
}
