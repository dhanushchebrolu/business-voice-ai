import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  getWhatsAppMessagingOverview,
  setWhatsAppNotificationSettings,
  syncWhatsAppTemplates,
  setWhatsAppTemplatePurpose,
  recordWhatsAppContactConsent,
  createWhatsAppCampaign,
  changeWhatsAppCampaign,
} from "@/lib/whatsapp-messaging.functions";

/**
 * Booking/payment notifications, Message Templates, customer consent and
 * template campaigns for the organization's WhatsApp numbers. Every rule
 * (roles, consent, approved templates, rate limits) is enforced by the
 * server functions; this panel only collects input and shows state.
 */

const PURPOSES = [
  ["booking_confirmed", "Booking confirmed (3 params)"],
  ["booking_rescheduled", "Booking rescheduled (3 params)"],
  ["booking_cancelled", "Booking cancelled (3 params)"],
  ["booking_reminder", "Booking reminder (3 params)"],
  ["payment_link", "Payment link (1 param)"],
  ["payment_confirmation", "Payment received (1 param)"],
  ["payment_failed", "Payment failed (1 param)"],
  ["payment_expired", "Payment expired (1 param)"],
] as const;

type ParamSource = "static" | "contact_first_name" | "business_name";

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function WhatsAppMessagingPanel({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const getOverview = useServerFn(getWhatsAppMessagingOverview);
  const saveSettings = useServerFn(setWhatsAppNotificationSettings);
  const syncTemplates = useServerFn(syncWhatsAppTemplates);
  const setPurpose = useServerFn(setWhatsAppTemplatePurpose);
  const recordConsent = useServerFn(recordWhatsAppContactConsent);
  const createCampaign = useServerFn(createWhatsAppCampaign);
  const changeCampaign = useServerFn(changeWhatsAppCampaign);

  const { data } = useQuery({
    queryKey: ["whatsapp-messaging", orgId],
    queryFn: () => getOverview(),
    refetchInterval: 30_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["whatsapp-messaging", orgId] });
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
      await refresh();
    } catch (error) {
      toast.error(errorText(error, "That didn't work."));
    } finally {
      setBusy(null);
    }
  };

  const [basis, setBasis] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState({
    contactId: "",
    scope: "marketing",
    action: "opt_in",
    evidence: "",
  });
  const [campaign, setCampaign] = useState({
    name: "",
    templateId: "",
    maxPerMinute: "20",
    windowStart: "",
    windowEnd: "",
  });
  const [params, setParams] = useState<{ source: ParamSource; value: string }[]>([]);

  if (!data) return null;
  const canAdmin = data.role === "owner" || data.role === "admin";
  const canManage = canAdmin || data.role === "manager";
  const canWrite = canManage || data.role === "staff";
  const marketingTemplates = data.templates.filter(
    (t) => t.status === "APPROVED" && t.category === "MARKETING",
  );
  const selectedTemplate = marketingTemplates.find((t) => t.id === campaign.templateId);
  const consentBusiness = data.connections.find((c) => c.business_id)?.business_id ?? null;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Booking & payment notifications"
        description="Confirmations, reschedules, cancellations, 24-hour reminders, payment links and payment results. Off until you turn it on and record how customers agree to these messages. Customers can reply STOP at any time."
      >
        <div className="space-y-4">
          {data.connections.map((c) => (
            <div key={c.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {c.display_phone_number ?? "WhatsApp number"}
                </span>
                <label className="flex items-center gap-2 text-xs">
                  Notifications
                  <Switch
                    checked={c.notifications_enabled}
                    disabled={!canAdmin || busy === `n-${c.id}`}
                    onCheckedChange={(enabled) =>
                      run(
                        `n-${c.id}`,
                        () =>
                          saveSettings({
                            data: {
                              connectionId: c.id,
                              enabled,
                              consentBasis: basis[c.id] ?? c.transactional_consent_basis ?? "",
                            },
                          }),
                        enabled ? "Notifications on." : "Notifications off.",
                      )
                    }
                  />
                </label>
              </div>
              <Textarea
                rows={2}
                maxLength={500}
                disabled={!canAdmin}
                placeholder="How customers agree to booking/payment messages, e.g. 'Customers are asked on the call and in the booking form whether we may send WhatsApp updates.'"
                value={basis[c.id] ?? c.transactional_consent_basis ?? ""}
                onChange={(e) => setBasis({ ...basis, [c.id]: e.target.value })}
              />
            </div>
          ))}
          {data.notifications.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Recent notifications</p>
              <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                {data.notifications.map((n) => (
                  <li key={n.id} className="flex justify-between gap-2">
                    <span>{n.kind.replace(/_/g, " ")}</span>
                    <span className="text-muted-foreground">
                      {n.status}
                      {n.skip_reason ? ` (${n.skip_reason})` : ""}
                      {n.status === "failed" && n.last_error ? ` — ${n.last_error}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Message templates"
        description="Synced from Meta. Outside the 24-hour window WhatsApp only allows approved templates: map a UTILITY template to each notification you want sent."
        actions={
          canManage
            ? data.connections.map((c) => (
                <Button
                  key={c.id}
                  size="sm"
                  variant="outline"
                  disabled={busy === `s-${c.id}`}
                  onClick={() =>
                    run(
                      `s-${c.id}`,
                      () => syncTemplates({ data: { connectionId: c.id } }),
                      "Templates synced.",
                    )
                  }
                >
                  Sync templates
                </Button>
              ))
            : null
        }
      >
        {data.templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No templates synced yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.templates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {t.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({t.language}, {t.category}, {t.body_param_count} params)
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusPill tone={t.status === "APPROVED" ? "live" : "idle"}>
                    {t.status}
                  </StatusPill>
                  {canAdmin && t.status === "APPROVED" && t.category === "UTILITY" ? (
                    <Select
                      value={t.purpose ?? "none"}
                      onValueChange={(v) =>
                        run(
                          `p-${t.id}`,
                          () =>
                            setPurpose({
                              data: {
                                templateId: t.id,
                                purpose: v === "none" ? null : (v as (typeof PURPOSES)[number][0]),
                              },
                            }),
                          "Template mapping saved.",
                        )
                      }
                    >
                      <SelectTrigger className="h-8 w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Not used for notifications</SelectItem>
                        {PURPOSES.map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Customer consent"
        description="Record a customer's consent you obtained outside WhatsApp (staff-attested, with evidence). Customers can also reply START or STOP themselves."
      >
        {canWrite && consentBusiness ? (
          <div className="grid gap-2 md:grid-cols-4">
            <Select
              value={consent.contactId}
              onValueChange={(v) => setConsent({ ...consent, contactId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Contact" />
              </SelectTrigger>
              <SelectContent>
                {data.contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name ?? c.phone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={consent.scope}
              onValueChange={(v) => setConsent({ ...consent, scope: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="marketing">Marketing</SelectItem>
                <SelectItem value="transactional">Booking & payment updates</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={consent.action}
              onValueChange={(v) => setConsent({ ...consent, action: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="opt_in">Opted in</SelectItem>
                <SelectItem value="opt_out">Opted out</SelectItem>
              </SelectContent>
            </Select>
            <Button
              disabled={!consent.contactId || busy === "consent"}
              onClick={() =>
                run(
                  "consent",
                  () =>
                    recordConsent({
                      data: {
                        contactId: consent.contactId,
                        businessId: consentBusiness,
                        scope: consent.scope,
                        action: consent.action,
                        evidence: consent.evidence,
                      },
                    }),
                  "Consent recorded.",
                )
              }
            >
              Record
            </Button>
            <Input
              className="md:col-span-4"
              maxLength={1000}
              placeholder="Evidence: how and when the customer agreed (required for opt-in)"
              value={consent.evidence}
              onChange={(e) => setConsent({ ...consent, evidence: e.target.value })}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Connect a number to a business to record consent.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Campaigns"
        description="Approved MARKETING templates, sent only to customers whose latest marketing consent is an opt-in and who aren't suppressed — re-checked before every message."
      >
        {canManage ? (
          <div className="mb-4 grid gap-2 rounded-lg border border-border p-3 md:grid-cols-2">
            <Input
              placeholder="Campaign name"
              maxLength={120}
              value={campaign.name}
              onChange={(e) => setCampaign({ ...campaign, name: e.target.value })}
            />
            <Select
              value={campaign.templateId}
              onValueChange={(v) => {
                const t = marketingTemplates.find((x) => x.id === v);
                setCampaign({ ...campaign, templateId: v });
                setParams(
                  Array.from({ length: t?.body_param_count ?? 0 }, () => ({
                    source: "static",
                    value: "",
                  })),
                );
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Approved marketing template" />
              </SelectTrigger>
              <SelectContent>
                {marketingTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.language})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTemplate?.body_text ? (
              <p className="whitespace-pre-wrap text-xs text-muted-foreground md:col-span-2">
                {selectedTemplate.body_text}
              </p>
            ) : null}
            {params.map((p, i) => (
              <div key={i} className="flex gap-2 md:col-span-2">
                <Select
                  value={p.source}
                  onValueChange={(v) =>
                    setParams(
                      params.map((x, j) => (j === i ? { ...x, source: v as ParamSource } : x)),
                    )
                  }
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="static">{`{{${i + 1}}} fixed text`}</SelectItem>
                    <SelectItem value="contact_first_name">{`{{${i + 1}}} customer first name`}</SelectItem>
                    <SelectItem value="business_name">{`{{${i + 1}}} business name`}</SelectItem>
                  </SelectContent>
                </Select>
                {p.source !== "business_name" ? (
                  <Input
                    maxLength={p.source === "static" ? 500 : 40}
                    placeholder={p.source === "static" ? "Text" : "Fallback if no name"}
                    value={p.value}
                    onChange={(e) =>
                      setParams(
                        params.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                      )
                    }
                  />
                ) : null}
              </div>
            ))}
            <Input
              type="number"
              min={1}
              max={80}
              placeholder="Messages per minute"
              value={campaign.maxPerMinute}
              onChange={(e) => setCampaign({ ...campaign, maxPerMinute: e.target.value })}
            />
            <div className="flex gap-2">
              <Input
                placeholder="Send from (HH:MM)"
                value={campaign.windowStart}
                onChange={(e) => setCampaign({ ...campaign, windowStart: e.target.value })}
              />
              <Input
                placeholder="until (HH:MM)"
                value={campaign.windowEnd}
                onChange={(e) => setCampaign({ ...campaign, windowEnd: e.target.value })}
              />
            </div>
            <Button
              className="md:col-span-2"
              disabled={!campaign.name || !campaign.templateId || busy === "create"}
              onClick={() =>
                run(
                  "create",
                  () =>
                    createCampaign({
                      data: {
                        name: campaign.name,
                        templateId: campaign.templateId,
                        templateParams: params.map((p) =>
                          p.source === "static"
                            ? { source: "static", value: p.value }
                            : p.source === "contact_first_name"
                              ? { source: "contact_first_name", fallback: p.value || "there" }
                              : { source: "business_name" },
                        ),
                        audience: { type: "all_consented" },
                        schedule:
                          campaign.windowStart && campaign.windowEnd
                            ? {
                                windowStart: campaign.windowStart,
                                windowEnd: campaign.windowEnd,
                                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                              }
                            : {},
                        maxPerMinute: Number(campaign.maxPerMinute) || 20,
                      },
                    }),
                  "Draft campaign created. Launch it when ready.",
                )
              }
            >
              Create draft campaign (audience: everyone opted in to marketing)
            </Button>
          </div>
        ) : null}
        <ul className="space-y-2">
          {data.campaigns.map((c) => (
            <li key={c.id} className="rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{c.name}</span>
                <StatusPill
                  tone={c.status === "running" ? "live" : c.status === "paused" ? "error" : "idle"}
                >
                  {c.status}
                </StatusPill>
              </div>
              {c.paused_reason ? (
                <p className="text-xs text-destructive">{c.paused_reason}</p>
              ) : null}
              <p className="mt-1 text-xs text-muted-foreground">
                {c.analytics.total} recipients · {c.analytics.pending} pending · {c.analytics.sent}{" "}
                sent · {c.analytics.delivered} delivered · {c.analytics.read} read ·{" "}
                {c.analytics.failed} failed ·{" "}
                {Object.values(c.analytics.skipped).reduce((a, b) => a + b, 0)} skipped
                {Object.keys(c.analytics.skipped).length > 0
                  ? ` (${Object.entries(c.analytics.skipped)
                      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
                      .join(", ")})`
                  : ""}
              </p>
              {canManage ? (
                <div className="mt-2 flex gap-2">
                  {(
                    [
                      ["launch", c.status === "draft"],
                      ["pause", c.status === "running" || c.status === "scheduled"],
                      ["resume", c.status === "paused"],
                      ["cancel", ["draft", "scheduled", "running", "paused"].includes(c.status)],
                    ] as const
                  )
                    .filter(([, show]) => show)
                    .map(([action]) => (
                      <Button
                        key={action}
                        size="sm"
                        variant={action === "cancel" ? "outline" : "default"}
                        disabled={busy === `${action}-${c.id}`}
                        onClick={() =>
                          run(
                            `${action}-${c.id}`,
                            () => changeCampaign({ data: { campaignId: c.id, action } }),
                            `Campaign ${action === "launch" ? "launched" : `${action}d`}.`,
                          )
                        }
                      >
                        {action[0]!.toUpperCase() + action.slice(1)}
                      </Button>
                    ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </SectionCard>

      {data.audit.length > 0 ? (
        <SectionCard
          title="Audit log"
          description="Consent, notification, template and campaign changes."
        >
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {data.audit.map((a) => (
              <li key={a.id} className="flex justify-between gap-2">
                <span>
                  {a.action} <span className="text-muted-foreground">({a.actor_type})</span>
                </span>
                <span className="text-muted-foreground">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
