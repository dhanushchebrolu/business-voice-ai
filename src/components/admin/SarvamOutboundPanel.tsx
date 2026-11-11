import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  createSarvamInboundDeployment,
  getSarvamAgentBrief,
  getSarvamOutboundGates,
  inspectSarvamAgent,
  listSarvamApplications,
  placeAdminSarvamOutboundCall,
  registerSarvamApplication,
  registerTelephonyConnection,
  setSarvamAppMapping,
  setSarvamApplicationMapping,
} from "@/lib/sarvam-admin.functions";
import { EMPLOYEE_TYPES, getEmployeeType, type EmployeeTypeId } from "@/lib/business-types";
import {
  activatePhoneNumber,
  importPhoneNumberToPool,
  listAllCalls,
  listPhoneNumbers,
  reassignPhoneNumber,
  releasePhoneNumber,
  setNumberDirection,
} from "@/lib/telephony-admin.functions";
import { normalizeCustomerPhone } from "@/lib/phone-number";
import { formatMoney } from "@/lib/pricing";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { CallDetailDialog } from "@/components/admin/CallDetailDialog";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface PanelNumber {
  id: string;
  e164: string;
  display_number: string | null;
  provider: string;
  status: string;
  outbound_enabled: boolean;
  connection_id: string | null;
  agent_config_id: string | null;
}

interface PanelProps {
  orgId: string;
  agent: {
    id: string;
    agent_name: string;
    sarvam_app_id: string | null;
    sarvam_app_version: number | null;
    sarvam_application_id?: string | null;
    employee_type?: string | null;
  } | null;
  numbers: PanelNumber[];
  connections: { id: string; provider: string; provider_connection_id: string | null }[];
  onChanged: () => void;
}

type NumberAction =
  | { kind: "activate"; number: PanelNumber }
  | { kind: "release"; number: PanelNumber }
  | { kind: "outbound"; number: PanelNumber; enabled: boolean };

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start justify-between gap-3 text-sm">
      <div>
        <p>{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <StatusPill tone={ok ? "live" : "error"}>{ok ? "Ready" : "Missing"}</StatusPill>
    </li>
  );
}

/**
 * Admin control for one customer's Sarvam outbound calling: connection and
 * agent mapping, number assignment from the pool, number state, a manually
 * approved real call, and that customer's recent calls. Every action is a
 * server function that re-checks admin rights and tenant ownership; this
 * component holds no secrets and decides nothing on its own.
 */
export function SarvamOutboundPanel({ orgId, agent, numbers, connections, onChanged }: PanelProps) {
  const registerConnection = useServerFn(registerTelephonyConnection);
  const mapAgent = useServerFn(setSarvamAppMapping);
  const assign = useServerFn(reassignPhoneNumber);
  const activate = useServerFn(activatePhoneNumber);
  const release = useServerFn(releasePhoneNumber);
  const setDirection = useServerFn(setNumberDirection);
  const placeCall = useServerFn(placeAdminSarvamOutboundCall);
  const fetchPool = useServerFn(listPhoneNumbers);
  const fetchCalls = useServerFn(listAllCalls);
  const fetchGates = useServerFn(getSarvamOutboundGates);
  const fetchApplications = useServerFn(listSarvamApplications);
  const registerApplication = useServerFn(registerSarvamApplication);
  const mapApplication = useServerFn(setSarvamApplicationMapping);
  const inspectAgent = useServerFn(inspectSarvamAgent);
  const [inspection, setInspection] = useState<string[] | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [mappingOpen, setMappingOpen] = useState(false);
  const [appId, setAppId] = useState(agent?.sarvam_app_id ?? "");
  const [appVersion, setAppVersion] = useState(String(agent?.sarvam_app_version ?? ""));
  // "" = enter an app id directly instead of using a registered template.
  const [applicationId, setApplicationId] = useState(agent?.sarvam_application_id ?? "");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [template, setTemplate] = useState({
    name: "",
    employeeType: "receptionist" as EmployeeTypeId,
    appId: "",
    version: "",
    shared: false,
  });
  const [assignOpen, setAssignOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importE164, setImportE164] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const importNumber = useServerFn(importPhoneNumberToPool);
  const fetchBrief = useServerFn(getSarvamAgentBrief);
  const createDeployment = useServerFn(createSarvamInboundDeployment);
  const brief = useQuery({
    queryKey: ["admin-sarvam-brief", orgId],
    queryFn: () => fetchBrief({ data: { orgId } }),
    enabled: briefOpen,
  });
  const [poolNumberId, setPoolNumberId] = useState("");
  const [numberAction, setNumberAction] = useState<NumberAction | null>(null);
  const [callOpen, setCallOpen] = useState(false);
  const [callNumberId, setCallNumberId] = useState("");
  const [destination, setDestination] = useState("");
  const [approved, setApproved] = useState(false);
  const [lastCall, setLastCall] = useState<{ callId: string; outcome: string } | null>(null);
  const [detailCallId, setDetailCallId] = useState<string | null>(null);

  const sarvamConnection = connections.find((c) => c.provider === "sarvam");
  const sarvamNumbers = numbers.filter((n) => n.provider === "sarvam" && n.status !== "released");
  const callable = sarvamNumbers.filter(
    (n) => n.status === "active" && n.outbound_enabled && !!n.connection_id && !!n.agent_config_id,
  );
  const agentMapped = Boolean(agent?.sarvam_app_id && agent.sarvam_app_version);
  const normalizedDestination = normalizeCustomerPhone(destination.trim(), null);

  const pool = useQuery({
    queryKey: ["admin-sarvam-pool"],
    queryFn: () => fetchPool({ data: { status: "available" } }),
    enabled: assignOpen,
  });
  const poolNumbers = (pool.data ?? []).filter((n) => n.provider === "sarvam");

  const applications = useQuery({
    queryKey: ["admin-sarvam-applications"],
    queryFn: () => fetchApplications(),
    enabled: mappingOpen,
  });
  const selectedApplication = applications.data?.applications.find((a) => a.id === applicationId);

  const gates = useQuery({
    queryKey: ["admin-sarvam-gates", orgId],
    queryFn: () => fetchGates({ data: { orgId } }),
  });

  const calls = useQuery({
    queryKey: ["admin-customer-calls", orgId],
    queryFn: () => fetchCalls({ data: { orgId, limit: 10 } }),
  });

  const refresh = () => {
    onChanged();
    void calls.refetch();
    void gates.refetch();
  };
  const gatesOk = Boolean(gates.data?.phoneAllowed && gates.data.walletOk);

  return (
    <SectionCard
      title="Sarvam outbound calling"
      description="Connect this customer's Sarvam setup, assign a number and place a manually approved call. Calls use the customer's own production gates and are billed to their wallet."
    >
      <ul className="space-y-3">
        <Check
          ok={Boolean(sarvamConnection?.provider_connection_id)}
          label="Sarvam telephony connection"
          detail={
            sarvamConnection?.provider_connection_id
              ? `Connection ${sarvamConnection.provider_connection_id}`
              : "Add the connection in Sarvam's dashboard, then record its ID here."
          }
        />
        <Check
          ok={agentMapped}
          label="Voice agent mapped to a Sarvam app"
          detail={
            !agent
              ? "This customer has no agent yet."
              : agentMapped
                ? `${agent.agent_name} (${getEmployeeType(agent.employee_type).label}) → app ${agent.sarvam_app_id} v${agent.sarvam_app_version}${agent.sarvam_application_id ? " via template" : ""}`
                : `${agent.agent_name} is not mapped. Author the app in Sarvam's dashboard first.`
          }
        />
        <Check
          ok={callable.length > 0}
          label="Callable Sarvam number"
          detail="Active, outbound enabled, linked to this customer's connection and agent."
        />
        <Check
          ok={gatesOk}
          label="Phone entitlement and wallet"
          detail={
            gates.isLoading
              ? "Checking…"
              : gates.error
                ? "Could not check entitlement and wallet."
                : !gates.data?.phoneAllowed
                  ? (gates.data?.phoneReason ?? "Phone calling is not enabled for this customer.")
                  : !gates.data.walletOk
                    ? "Wallet balance is below one minute of outbound calling."
                    : "Phone calling enabled and wallet covers at least one minute."
          }
        />
      </ul>
      {gates.data?.billingGatesBypassed ? (
        <p className="mt-3 rounded-md border border-destructive/50 p-2 text-xs text-destructive">
          BYPASS_BILLING_GATES is on for this server: entitlement checks pass for every customer.
          Turn it off before placing calls you expect to be gated.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setConnectionOpen(true)}>
          {sarvamConnection?.provider_connection_id ? "Update connection" : "Register connection"}
        </Button>
        <Button size="sm" variant="outline" disabled={!agent} onClick={() => setMappingOpen(true)}>
          Map Sarvam app
        </Button>
        <Button size="sm" variant="outline" onClick={() => setTemplateOpen(true)}>
          Register Sarvam template
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
          Assign number from pool
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          Import Sarvam number
        </Button>
        <Button size="sm" variant="outline" disabled={!agent} onClick={() => setBriefOpen(true)}>
          Agent brief for Sarvam
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={callable.length === 0 || !agentMapped}
          onClick={() => setDeploymentOpen(true)}
        >
          Create inbound deployment
        </Button>
      </div>
      {briefOpen ? (
        <div className="mt-3 space-y-2 rounded-md border border-border p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">Sarvam agent brief</p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setBriefOpen(false)}
            >
              Close
            </Button>
          </div>
          {brief.isLoading ? (
            <p className="text-xs text-muted-foreground">Building from this customer's data…</p>
          ) : brief.error ? (
            <p className="text-xs text-destructive">{(brief.error as Error).message}</p>
          ) : brief.data ? (
            <>
              <p className="text-xs text-muted-foreground">
                Sarvam's API cannot create agents. Author this customer's dedicated app in Sarvam's
                dashboard (or Sarvam MCP) with exactly this, commit a version, then map it above.
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Business</dt>
                <dd>{brief.data.businessName}</dd>
                <dt className="text-muted-foreground">AI employee</dt>
                <dd>{brief.data.employeeType}</dd>
                <dt className="text-muted-foreground">Agent name</dt>
                <dd>{brief.data.agentName}</dd>
                <dt className="text-muted-foreground">Language / voice</dt>
                <dd>
                  {brief.data.primaryLanguage} / {brief.data.voiceId}
                </dd>
                <dt className="text-muted-foreground">On-start context URL</dt>
                <dd className="break-all font-mono">
                  {brief.data.clientContextUrl
                    ? `${brief.data.clientContextUrl}?verify_token=<SARVAM_CONTEXT_SECRET>`
                    : "TELEPHONY_WEBHOOK_BASE_URL is not set"}
                  {brief.data.clientContextSecretConfigured ? "" : " (secret not configured)"}
                </dd>
              </dl>
              <p className="text-xs font-medium">Greeting</p>
              <p className="rounded bg-muted p-2 text-xs">{brief.data.greeting || "—"}</p>
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Instructions</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(brief.data!.instructions);
                    toast.success("Instructions copied");
                  }}
                >
                  Copy
                </Button>
              </div>
              <textarea
                readOnly
                aria-label="Agent instructions for Sarvam"
                value={brief.data.instructions}
                className="h-48 w-full rounded border border-input bg-background p-2 font-mono text-xs"
              />
            </>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 border-t border-border pt-3">
        <p className="text-sm font-medium">Sarvam numbers</p>
        {sarvamNumbers.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">No Sarvam number assigned.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {sarvamNumbers.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-mono">{n.display_number ?? n.e164}</span>
                <StatusPill tone={n.status === "active" ? "live" : "idle"}>{n.status}</StatusPill>
                <span className="text-xs text-muted-foreground">
                  Outbound {n.outbound_enabled ? "on" : "off"}
                  {n.connection_id ? "" : " · no connection"}
                  {n.agent_config_id ? "" : " · no agent"}
                </span>
                <span className="ml-auto flex gap-1.5">
                  {n.status !== "active" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => setNumberAction({ kind: "activate", number: n })}
                    >
                      Activate
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() =>
                      setNumberAction({ kind: "outbound", number: n, enabled: !n.outbound_enabled })
                    }
                  >
                    {n.outbound_enabled ? "Disable outbound" : "Enable outbound"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs text-destructive"
                    onClick={() => setNumberAction({ kind: "release", number: n })}
                  >
                    Release
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Place an outbound call</p>
          <Button
            size="sm"
            disabled={callable.length === 0 || !gatesOk}
            onClick={() => {
              setCallNumberId(callable[0]?.id ?? "");
              setApproved(false);
              setCallOpen(true);
            }}
          >
            New call
          </Button>
        </div>
        {callable.length === 0 || !gatesOk ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Every check above must be ready before a call can be placed.
          </p>
        ) : null}
        {lastCall ? (
          <p className="mt-2 text-xs">
            {lastCall.outcome === "unknown"
              ? "Sarvam did not confirm the call start — it is held as Unconfirmed and will not be redialled. "
              : "Call request accepted by Sarvam. "}
            <button className="underline" onClick={() => setDetailCallId(lastCall.callId)}>
              View call {lastCall.callId.slice(0, 8)}
            </button>
          </p>
        ) : null}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <p className="text-sm font-medium">Recent calls</p>
        {calls.isLoading ? (
          <p className="mt-1 text-xs text-muted-foreground">Loading…</p>
        ) : calls.error ? (
          <p className="mt-1 text-xs text-destructive">Could not load calls.</p>
        ) : (calls.data ?? []).length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No calls yet.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {(calls.data ?? []).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                <span className="font-mono">{c.destinationNumber ?? c.callerNumber ?? "—"}</span>
                <StatusPill tone={c.status === "completed" ? "live" : "idle"}>
                  {c.status === "outcome_unknown" ? "Unconfirmed" : c.status}
                </StatusPill>
                <span className="text-muted-foreground">
                  {c.durationSeconds}s · {formatMoney(c.customerCharge, c.currency)} ·{" "}
                  {new Date(c.startedAt).toLocaleString()}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-7 text-xs"
                  onClick={() => setDetailCallId(c.id)}
                >
                  Details
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ReasonDialog
        open={connectionOpen}
        onOpenChange={setConnectionOpen}
        title="Register Sarvam connection"
        description="Record the connection ID from Sarvam's dashboard (Deploy → Connections). This customer's Sarvam numbers without a connection are linked to it."
        confirmLabel="Save connection"
        extra={
          <Input
            aria-label="Sarvam connection ID"
            placeholder="Sarvam connection ID"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
          />
        }
        onConfirm={async (reason) => {
          await registerConnection({
            data: { orgId, providerConnectionId: connectionId.trim(), reason },
          });
          toast.success("Sarvam connection saved");
          setConnectionId("");
          refresh();
        }}
      />

      <ReasonDialog
        open={mappingOpen}
        onOpenChange={setMappingOpen}
        title="Map agent to Sarvam app"
        description="Choose a registered template, or enter the app ID and published version from Sarvam's dashboard. Calls use exactly this app version."
        confirmLabel="Save mapping"
        extra={
          <div className="space-y-2">
            <Select
              value={applicationId || "direct"}
              onValueChange={(v) => setApplicationId(v === "direct" ? "" : v)}
            >
              <SelectTrigger aria-label="Sarvam template">
                <SelectValue placeholder="Template" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">Enter app ID directly</SelectItem>
                {(applications.data?.applications ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} · {getEmployeeType(a.employee_type).label} · v{a.sarvam_app_version}
                    {a.is_shared ? " · shared" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedApplication?.is_shared && !applications.data?.sharedEnabled ? (
              <p className="text-xs text-destructive">
                Shared templates are turned off on this server (SARVAM_SHARED_APPLICATIONS_ENABLED).
              </p>
            ) : null}
            {applicationId ? null : (
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label="Sarvam app ID"
                  placeholder="Sarvam app ID"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                />
                <Input
                  aria-label="Sarvam app version"
                  type="number"
                  min={1}
                  placeholder="Version"
                  value={appVersion}
                  onChange={(e) => setAppVersion(e.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="col-span-2"
                  disabled={!appId.trim() || inspecting}
                  onClick={async () => {
                    setInspecting(true);
                    try {
                      const r = await inspectAgent({
                        data: {
                          appId: appId.trim(),
                          appVersion: Number(appVersion) || undefined,
                          agentPhoneNumber: sarvamNumbers[0]?.e164,
                        },
                      });
                      setInspection([
                        r.agentRecognized === true
                          ? "Sarvam knows this agent ID."
                          : r.agentRecognized === false
                            ? "Sarvam does not know this agent ID (404)."
                            : "No deployment or past call proves this agent ID; Sarvam will validate it when a call starts.",
                        `Calls in the last 90 days: ${r.interactionsLast90Days ?? `unavailable (${r.interactionsError})`}`,
                        r.deploymentsError
                          ? `Deployments: unavailable (${r.deploymentsError})`
                          : `Deployments of this agent: ${
                              r.appDeployments
                                .map(
                                  (d) =>
                                    `v${d.appVersion} ${d.channelDirection ?? ""} ${d.status ?? ""} [${d.phoneNumbers.length} number(s)]`,
                                )
                                .join("; ") || "none (not needed for instant outbound)"
                            }`,
                        ...(sarvamNumbers[0]
                          ? [
                              `Deployments using ${sarvamNumbers[0].e164}: ${
                                r.numberDeployments
                                  .map((d) => `${d.appId} v${d.appVersion}`)
                                  .join("; ") || "none"
                              }`,
                            ]
                          : []),
                      ]);
                    } catch (err) {
                      setInspection([`Check failed: ${(err as Error).message}`]);
                    } finally {
                      setInspecting(false);
                    }
                  }}
                >
                  {inspecting ? "Checking…" : "Check in Sarvam (read-only)"}
                </Button>
                {inspection ? (
                  <ul className="col-span-2 space-y-0.5 text-xs text-muted-foreground">
                    {inspection.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </div>
        }
        onConfirm={async (reason) => {
          if (!agent) throw new Error("This customer has no agent.");
          if (applicationId) {
            await mapApplication({ data: { agentConfigId: agent.id, applicationId, reason } });
            toast.success("Agent mapped to Sarvam template");
            refresh();
            return;
          }
          await mapAgent({
            data: {
              agentConfigId: agent.id,
              sarvamAppId: appId.trim(),
              sarvamAppVersion: Number(appVersion),
              reason,
            },
          });
          toast.success("Agent mapped to Sarvam app");
          refresh();
        }}
      />

      <ReasonDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        title="Register Sarvam template"
        description="Record an app version authored in Sarvam's dashboard so agents can be mapped to it. A shared template can serve several customers; each call still carries only that customer's own business details."
        confirmLabel="Register template"
        extra={
          <div className="space-y-2">
            <Input
              aria-label="Template name"
              placeholder="Name, e.g. Booking"
              value={template.name}
              onChange={(e) => setTemplate({ ...template, name: e.target.value })}
            />
            <Select
              value={template.employeeType}
              onValueChange={(v) => setTemplate({ ...template, employeeType: v as EmployeeTypeId })}
            >
              <SelectTrigger aria-label="AI employee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMPLOYEE_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="grid grid-cols-2 gap-2">
              <Input
                aria-label="Template Sarvam app ID"
                placeholder="Sarvam app ID"
                value={template.appId}
                onChange={(e) => setTemplate({ ...template, appId: e.target.value })}
              />
              <Input
                aria-label="Template Sarvam app version"
                type="number"
                min={1}
                placeholder="Version"
                value={template.version}
                onChange={(e) => setTemplate({ ...template, version: e.target.value })}
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={template.shared}
                onCheckedChange={(v) => setTemplate({ ...template, shared: Boolean(v) })}
                className="mt-0.5"
              />
              <span>Shared: can be mapped to more than one customer</span>
            </label>
          </div>
        }
        onConfirm={async (reason) => {
          await registerApplication({
            data: {
              name: template.name,
              employeeType: template.employeeType,
              sarvamAppId: template.appId.trim(),
              sarvamAppVersion: Number(template.version),
              isShared: template.shared,
              reason,
            },
          });
          toast.success("Sarvam template registered");
          setTemplate({
            name: "",
            employeeType: "receptionist",
            appId: "",
            version: "",
            shared: false,
          });
          void applications.refetch();
        }}
      />

      <ReasonDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        title="Import a Sarvam number for this customer"
        description="Records a number you rented in Sarvam (Deploy → Phone Numbers) and assigns it to this customer. It arrives inactive with calling off."
        confirmLabel="Import and assign"
        extra={
          <Input
            aria-label="Sarvam number"
            placeholder="+91…"
            value={importE164}
            onChange={(e) => setImportE164(e.target.value)}
          />
        }
        onConfirm={async (reason) => {
          const e164 = normalizeCustomerPhone(importE164.trim(), null);
          if (!e164) throw new Error("Enter the number with its country code, e.g. +91…");
          const imported = await importNumber({ data: { provider: "sarvam", e164, reason } });
          await assign({ data: { numberId: imported.id, toOrgId: orgId, reason } });
          toast.success("Number imported and assigned");
          setImportE164("");
          refresh();
        }}
      />

      <ReasonDialog
        open={deploymentOpen}
        onOpenChange={setDeploymentOpen}
        title="Create Sarvam inbound deployment"
        description="Creates a deployment in Sarvam so calls to this customer's active Sarvam numbers are answered by their mapped app. This changes Sarvam's routing for these numbers; it does not place any call."
        confirmLabel="Create deployment"
        onConfirm={async (reason) => {
          await createDeployment({
            data: {
              phoneNumberIds: callable.map((n) => n.id),
              name: `ClickAI ${orgId.slice(0, 8)} inbound`,
              reason,
            },
          });
          toast.success("Inbound deployment created");
          refresh();
        }}
      />

      <ReasonDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title="Assign a Sarvam number"
        description="Moves an unassigned pool number to this customer. It arrives inactive with calling off; activate it and enable outbound below."
        confirmLabel="Assign number"
        extra={
          pool.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading pool…</p>
          ) : poolNumbers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No unassigned Sarvam numbers. Rent one in Sarvam's dashboard, then import it on the
              Numbers page.
            </p>
          ) : (
            <Select value={poolNumberId} onValueChange={setPoolNumberId}>
              <SelectTrigger aria-label="Pool number">
                <SelectValue placeholder="Choose a number" />
              </SelectTrigger>
              <SelectContent>
                {poolNumbers.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.display_number ?? n.e164}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        }
        onConfirm={async (reason) => {
          if (!poolNumberId) throw new Error("Choose a number");
          await assign({ data: { numberId: poolNumberId, toOrgId: orgId, reason } });
          toast.success("Number assigned");
          setPoolNumberId("");
          void pool.refetch();
          refresh();
        }}
      />

      <ReasonDialog
        open={numberAction !== null}
        onOpenChange={(open) => {
          if (!open) setNumberAction(null);
        }}
        title={
          numberAction?.kind === "activate"
            ? "Activate number"
            : numberAction?.kind === "release"
              ? "Release number"
              : numberAction?.kind === "outbound" && numberAction.enabled
                ? "Enable outbound calling"
                : "Disable outbound calling"
        }
        description={
          numberAction?.kind === "release"
            ? `Releases ${numberAction.number.e164} from this customer and turns all calling off. This cannot be undone here.`
            : `Applies to ${numberAction?.number.e164 ?? "this number"}.`
        }
        onConfirm={async (reason) => {
          if (!numberAction) return;
          const numberId = numberAction.number.id;
          if (numberAction.kind === "activate") await activate({ data: { numberId, reason } });
          else if (numberAction.kind === "release") await release({ data: { numberId, reason } });
          else
            await setDirection({
              data: { numberId, direction: "outbound", enabled: numberAction.enabled, reason },
            });
          toast.success("Number updated");
          refresh();
        }}
      />

      <ReasonDialog
        open={callOpen}
        onOpenChange={setCallOpen}
        title="Place a real outbound call?"
        description="This dials a real phone through Sarvam and bills this customer's wallet. It is placed once and never retried."
        confirmLabel="Place call"
        extra={
          <div className="space-y-3">
            <Select value={callNumberId} onValueChange={setCallNumberId}>
              <SelectTrigger aria-label="Call from">
                <SelectValue placeholder="Call from" />
              </SelectTrigger>
              <SelectContent>
                {callable.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.display_number ?? n.e164}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Destination number"
              placeholder="Destination, e.g. +919876543210"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
            {destination.trim() && !normalizedDestination ? (
              <p className="text-xs text-destructive">
                Enter the number with its country code, e.g. +91…
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Agent: {agent?.agent_name ?? "—"} (Sarvam app {agent?.sarvam_app_id ?? "—"} v
              {agent?.sarvam_app_version ?? "—"})
            </p>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={approved}
                onCheckedChange={(v) => setApproved(Boolean(v))}
                className="mt-0.5"
              />
              <span>
                I approve one call to {normalizedDestination ?? "this number"}, and the person
                expects it.
              </span>
            </label>
          </div>
        }
        onConfirm={async (reason) => {
          if (!callNumberId) throw new Error("Choose the number to call from");
          if (!normalizedDestination)
            throw new Error("Enter the destination with its country code, e.g. +91…");
          if (!approved) throw new Error("Tick the approval box to place the call");
          const result = await placeCall({
            data: {
              orgId,
              phoneNumberId: callNumberId,
              toE164: normalizedDestination,
              confirmCall: true,
              reason,
            },
          });
          setLastCall(result);
          // Fresh approval and number for the next call: no accidental redial.
          setApproved(false);
          setDestination("");
          if (result.outcome === "unknown")
            toast.warning("Call start unconfirmed", {
              description: "Held for review in Calls. It will not be redialled.",
            });
          else toast.success("Call placed");
          void calls.refetch();
        }}
      />

      <CallDetailDialog
        callId={detailCallId}
        onOpenChange={(open) => {
          if (!open) setDetailCallId(null);
        }}
      />
    </SectionCard>
  );
}
