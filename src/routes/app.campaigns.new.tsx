import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, numbersQuery } from "@/lib/workspace";
import { supabase } from "@/integrations/supabase/client";
import { describeQueryError } from "@/lib/query-error";
import { LANGUAGES } from "@/lib/voices";
import { PageHeader, SectionCard } from "@/components/app/primitives";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/app/campaigns/new")({
  head: () => ({
    meta: [{ title: "Create campaign — ClickAI" }, { name: "robots", content: "noindex" }],
  }),
  component: NewCampaignPage,
});

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function NewCampaignPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: numbers } = useQuery(numbersQuery(orgId));
  const outboundNumbers = (numbers ?? []).filter(
    (n) => n.status === "active" && n.outbound_enabled,
  );

  const [name, setName] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [description, setDescription] = useState("");
  const [budgetRupees, setBudgetRupees] = useState("");
  const [language, setLanguage] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [windowStart, setWindowStart] = useState("10:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [retryAfterMinutes, setRetryAfterMinutes] = useState(120);
  const [saving, setSaving] = useState(false);

  function toggleDay(d: number) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  }

  async function createCampaign() {
    if (!orgId || !ws?.agent) {
      toast.error("Configure your AI receptionist before creating a campaign.");
      return;
    }
    if (!name.trim()) {
      toast.error("Give this campaign a name.");
      return;
    }
    if (!phoneNumberId) {
      toast.error("Choose which number the AI should call from.");
      return;
    }
    if (!description.trim()) {
      toast.error("Describe why you are calling these people.");
      return;
    }
    const budget = budgetRupees.trim() ? Math.round(Number(budgetRupees) * 100) : null;
    if (budget !== null && !(Number.isFinite(budget) && budget > 0)) {
      toast.error("Enter the budget in rupees, or leave it empty for no limit.");
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("campaigns")
        .insert({
          organization_id: orgId,
          business_id: ws.business?.id ?? null,
          agent_config_id: ws.agent.id,
          phone_number_id: phoneNumberId,
          name: name.trim(),
          description: description.trim(),
          budget_limit: budget,
          language: language || null,
          schedule: {
            startDate: startDate || undefined,
            endDate: endDate || undefined,
            windowStart: windowStart || undefined,
            windowEnd: windowEnd || undefined,
            days,
            timezone: ws.organization?.timezone ?? "Asia/Kolkata",
          } as never,
          max_attempts: maxAttempts,
          retry_after_minutes: retryAfterMinutes,
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      if (error || !data) {
        toast.error(describeQueryError(error, "Could not create this campaign."));
        return;
      }
      toast.success("Campaign created. Review what the AI will say, then add contacts.");
      navigate({ to: "/app/campaigns/$campaignId", params: { campaignId: data.id } });
    } catch (err) {
      toast.error(describeQueryError(err, "Could not create this campaign."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create campaign"
        description="Have your AI receptionist call a list of customers automatically."
      />

      <SectionCard title="Campaign details">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Campaign name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Appointment Reminder"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Caller number</Label>
            <Select value={phoneNumberId} onValueChange={setPhoneNumberId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a number" />
              </SelectTrigger>
              <SelectContent>
                {outboundNumbers.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.e164}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {outboundNumbers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No number is enabled for outbound calling yet — contact support.
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          <Label>AI voice agent</Label>
          <p className="rounded-md border border-border bg-surface/50 px-3 py-2 text-sm">
            {ws?.agent?.agent_name ?? "Not configured"}
          </p>
        </div>
      </SectionCard>

      <SectionCard
        title="What should the AI do on this call?"
        description="Plain language — no technical prompts required."
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Describe the campaign</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Call customers who haven't visited in six months. Introduce yourself, ask if they would like a check-up, answer questions about our services, check availability if they are interested, and tell them how to confirm. Don't pressure anyone; if they decline, end politely."
              rows={6}
              maxLength={4000}
            />
            <p className="text-xs text-muted-foreground">
              Next you'll review the structured version ClickAI prepares from this before any call
              is made. The AI can share information and check availability; it cannot book, schedule
              callbacks or send messages.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Language</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Same as agent default" />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Schedule" description="Calls only ever happen inside this window.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Start date</Label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>End date (optional)</Label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Calling hours start</Label>
            <Input
              type="time"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Calling hours end</Label>
            <Input type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          <Label>Calling days</Label>
          <div className="flex flex-wrap gap-3">
            {DAY_LABELS.map((label, i) => (
              <label key={i} className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={days.includes(i)} onCheckedChange={() => toggleDay(i)} />
                {label}
              </label>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Budget (optional)"
        description="ClickAI stops calling and pauses the campaign before spending more than this."
      >
        <div className="space-y-1.5">
          <Label>Campaign budget (₹)</Label>
          <Input
            type="number"
            min={1}
            step="1"
            inputMode="numeric"
            className="w-56"
            value={budgetRupees}
            onChange={(e) => setBudgetRupees(e.target.value)}
            placeholder="No limit"
          />
          <p className="text-xs text-muted-foreground">
            Each call reserves its maximum cost (5 minutes) until it is billed.
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Retries">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Maximum attempts per contact</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(Number(e.target.value) || 1)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Retry after (minutes)</Label>
            <Input
              type="number"
              min={15}
              value={retryAfterMinutes}
              onChange={(e) => setRetryAfterMinutes(Number(e.target.value) || 15)}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Retries on no-answer, busy, or a failed call. A customer who declines, asks not to be
          called again, or whose call completes successfully is never retried.
        </p>
      </SectionCard>

      <div className="flex justify-end">
        <Button onClick={createCampaign} disabled={saving}>
          {saving ? "Creating…" : "Create campaign"}
        </Button>
      </div>
    </div>
  );
}
