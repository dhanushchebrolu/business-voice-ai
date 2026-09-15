import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, numbersQuery } from "@/lib/workspace";
import { agentStatusLabel } from "@/lib/agent-status";
import { LANGUAGES, VOICES, PACE_MIN, PACE_MAX } from "@/lib/voices";
import { PERSONAS, CAPABILITIES } from "@/lib/business-types";
import {
  previewAgentConfig,
  saveAgentConfiguration,
  testAgentText,
  getProviderStatus,
} from "@/lib/agent.functions";
import { PageHeader, SectionCard, LoadingState, StatusPill } from "@/components/app/primitives";
import { ServiceLocked } from "@/components/app/ServiceLocked";
import { featureLocksQuery } from "@/lib/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/app/agent")({
  head: () => ({
    meta: [
      { title: "AI receptionist — Vaani" },
      {
        name: "description",
        content: "Configure persona, voice, language and behaviour for your AI receptionist.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AgentPage,
});

function AgentPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: ws, isLoading } = useQuery(workspaceQuery(user?.id));
  const business = ws?.business ?? null;
  const agent = ws?.agent ?? null;
  const { data: locks } = useQuery(featureLocksQuery(ws?.organization?.id));
  const { data: numbers } = useQuery(numbersQuery(ws?.organization?.id));
  const activeNumber = numbers?.find((n) => n.status === "active");
  // Informational only — the save button is never blocked by this (a
  // customer mid-setup, before any payment, must still be able to save and
  // prepare their agent). The real, unbypassable gate is
  // saveAgentConfiguration's own checkFeatureAccess("voice") call, which
  // decides whether a save can actually reach "ready" — and
  // checkTelephonyAccess's independent re-check at real call time either
  // way. This banner exists purely to explain why a save might land as
  // "Incomplete" for a reason that isn't a missing field.
  const voiceLocked = locks?.["voice"] === true;
  const lifecycle = ws?.organization?.lifecycle_status ?? "not_provisioned";

  const provider = useServerFn(getProviderStatus);
  const preview = useServerFn(previewAgentConfig);
  const saveConfig = useServerFn(saveAgentConfiguration);
  const testText = useServerFn(testAgentText);

  const { data: providerStatus } = useQuery({
    queryKey: ["provider-status"],
    queryFn: () => provider({}),
  });
  const { data: previewData, refetch: refetchPreview } = useQuery({
    queryKey: ["agent-preview", business?.id],
    enabled: Boolean(business?.id),
    queryFn: () => preview({ data: { businessId: business!.id } }),
  });

  const [form, setForm] = useState({
    agent_name: "",
    persona: "professional",
    primary_language: "en-IN",
    voice_id: "simran",
    speaking_pace: 1,
    multilingual: true,
    after_hours_behavior: "take_message",
    transfer_number: "",
    custom_personality: "",
    greeting: "",
    capabilities: {} as Record<string, boolean>,
  });
  const [saving, setSaving] = useState(false);
  const [chat, setChat] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [message, setMessage] = useState("");
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    if (agent) {
      const greetings = (agent.greetings as Record<string, string> | null) ?? {};
      setForm({
        agent_name: agent.agent_name,
        persona: agent.persona,
        primary_language: agent.primary_language,
        voice_id: agent.voice_id,
        speaking_pace: agent.speaking_pace,
        multilingual: agent.multilingual,
        after_hours_behavior: agent.after_hours_behavior,
        transfer_number: agent.transfer_number ?? "",
        custom_personality: agent.custom_personality ?? "",
        greeting: greetings[agent.primary_language] ?? "",
        capabilities: (agent.capabilities as Record<string, boolean> | null) ?? {},
      });
    }
  }, [agent]);

  if (isLoading || !business || !agent) return <LoadingState label="Loading receptionist" />;

  async function save() {
    if (!agent || !business) return;
    setSaving(true);
    try {
      const result = await saveConfig({
        data: {
          businessId: business.id,
          agent_name: form.agent_name,
          persona: form.persona,
          primary_language: form.primary_language,
          voice_id: form.voice_id,
          speaking_pace: form.speaking_pace,
          multilingual: form.multilingual,
          after_hours_behavior: form.after_hours_behavior,
          transfer_number: form.transfer_number || null,
          custom_personality: form.custom_personality || null,
          greeting: form.greeting,
          capabilities: form.capabilities,
        },
      });
      if (result.ready) {
        toast.success("Saved. Your receptionist is active for new calls.");
      } else {
        toast(result.issues.length ? "Saved as an incomplete draft." : "Saved.", {
          description: result.issues[0]?.message,
        });
      }
      await qc.invalidateQueries();
      refetchPreview();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the configuration.");
    } finally {
      setSaving(false);
    }
  }

  async function send() {
    if (!business || !message.trim()) return;
    const history = [...chat, { role: "user" as const, content: message.trim() }];
    setChat(history);
    setMessage("");
    setThinking(true);
    try {
      const res = await testText({ data: { businessId: business.id, history } });
      if (res.ok) setChat([...history, { role: "assistant", content: res.reply }]);
      else toast.error(res.error);
    } catch {
      toast.error("The test call failed. Please retry.");
    } finally {
      setThinking(false);
    }
  }

  const issues = previewData?.issues ?? [];
  // Real status only — never a fake "connected"/"published"/"deployed"
  // claim. agentStatusLabel already refuses to say Ready/Live while
  // required fields are missing, a Sarvam-managed number's app mapping is
  // absent, or the account is billing-locked; it says exactly why not.
  const agentStatus = agentStatusLabel(agent, Boolean(activeNumber), activeNumber?.provider);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI receptionist"
        description="Persona, voice and behaviour. Saving updates the active receptionist configuration — no separate publish step."
        actions={
          <>
            <StatusPill tone={providerStatus?.ai === "connected" ? "live" : "idle"}>
              {providerStatus?.ai === "connected" ? "AI connected" : "AI not connected"}
            </StatusPill>
            <StatusPill tone={agentStatus.tone}>{agentStatus.label}</StatusPill>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}Save configuration
            </Button>
          </>
        }
      />

      {voiceLocked ? <ServiceLocked feature="voice" lifecycle={lifecycle} compact /> : null}

      {issues.length ? (
        <div className="rounded-lg border border-warning/30 bg-warning/8 px-4 py-3 text-sm">
          <p className="font-medium">Resolve to activate</p>
          <ul className="mt-1.5 list-inside list-disc text-muted-foreground">
            {issues.map((issue) => (
              <li key={issue.field}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Tabs defaultValue="identity">
        <TabsList>
          <TabsTrigger value="identity">Identity & voice</TabsTrigger>
          <TabsTrigger value="behaviour">Behaviour</TabsTrigger>
          <TabsTrigger value="instructions">Instructions</TabsTrigger>
          <TabsTrigger value="test">Test</TabsTrigger>
        </TabsList>

        <TabsContent value="identity" className="mt-4 grid gap-4 lg:grid-cols-2">
          <SectionCard title="Identity" description="How the receptionist introduces itself.">
            <div className="space-y-4">
              <FieldRow label="Agent name">
                <Input
                  value={form.agent_name}
                  onChange={(e) => setForm({ ...form, agent_name: e.target.value })}
                />
              </FieldRow>
              <FieldRow label="Persona">
                <Select
                  value={form.persona}
                  onValueChange={(v) => setForm({ ...form, persona: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERSONAS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Greeting">
                <Textarea
                  rows={3}
                  value={form.greeting}
                  onChange={(e) => setForm({ ...form, greeting: e.target.value })}
                />
              </FieldRow>
              <FieldRow label="Extra personality notes">
                <Textarea
                  rows={3}
                  value={form.custom_personality}
                  onChange={(e) => setForm({ ...form, custom_personality: e.target.value })}
                  placeholder="Warm, uses the caller's name, avoids jargon."
                />
              </FieldRow>
            </div>
          </SectionCard>

          <SectionCard
            title="Voice & language"
            description="Speech is produced by Sarvam's Bulbul voices."
          >
            <div className="space-y-4">
              <FieldRow label="Primary language">
                <Select
                  value={form.primary_language}
                  onValueChange={(v) => setForm({ ...form, primary_language: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label} — {l.native}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Voice">
                <Select
                  value={form.voice_id}
                  onValueChange={(v) => setForm({ ...form, voice_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {VOICES.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name} · {v.gender}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label={`Speaking pace — ${form.speaking_pace.toFixed(2)}x`}>
                <Slider
                  min={PACE_MIN}
                  max={PACE_MAX}
                  step={0.05}
                  value={[form.speaking_pace]}
                  onValueChange={(vals) => setForm({ ...form, speaking_pace: vals[0] ?? 1 })}
                />
              </FieldRow>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
                <span className="text-sm">
                  Switch language automatically
                  <span className="block text-xs text-muted-foreground">
                    Replies in whichever language the caller uses.
                  </span>
                </span>
                <Switch
                  checked={form.multilingual}
                  onCheckedChange={(v) => setForm({ ...form, multilingual: v })}
                />
              </label>
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="behaviour" className="mt-4 grid gap-4 lg:grid-cols-2">
          <SectionCard
            title="Capabilities"
            description="What the receptionist is allowed to do on a call."
          >
            <ul className="space-y-2">
              {CAPABILITIES.map((cap) => (
                <li
                  key={cap.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5"
                >
                  <span className="text-sm">
                    {cap.label}
                    <span className="block text-xs text-muted-foreground">{cap.description}</span>
                  </span>
                  <Switch
                    checked={Boolean(form.capabilities[cap.id])}
                    onCheckedChange={(v) =>
                      setForm({ ...form, capabilities: { ...form.capabilities, [cap.id]: v } })
                    }
                  />
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard
            title="Escalation & after hours"
            description="What happens when the agent cannot help."
          >
            <div className="space-y-4">
              <FieldRow label="Transfer number">
                <Input
                  value={form.transfer_number}
                  onChange={(e) => setForm({ ...form, transfer_number: e.target.value })}
                  placeholder="+91 98765 43210"
                />
              </FieldRow>
              <FieldRow label="After-hours behaviour">
                <Select
                  value={form.after_hours_behavior}
                  onValueChange={(v) => setForm({ ...form, after_hours_behavior: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="take_message">Take a message</SelectItem>
                    <SelectItem value="answer_normally">Answer questions normally</SelectItem>
                    <SelectItem value="transfer">Transfer to the number above</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="instructions" className="mt-4">
          <SectionCard
            title="Generated instructions"
            description="Compiled from your business profile. This is exactly what grounds the agent — no model training involved."
            actions={
              <Button size="sm" variant="ghost" onClick={() => refetchPreview()}>
                Regenerate
              </Button>
            }
          >
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface/60 p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {previewData?.instructions ?? "Generating…"}
            </pre>
          </SectionCard>
        </TabsContent>

        <TabsContent value="test" className="mt-4">
          <SectionCard
            title="Test conversation"
            description="Talk to the agent in text using your currently saved grounding."
          >
            <div className="space-y-3">
              <div className="max-h-[360px] space-y-2 overflow-y-auto">
                {chat.length ? (
                  chat.map((turn, i) => (
                    <div
                      key={i}
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                        turn.role === "user"
                          ? "ml-auto bg-primary/12"
                          : "border border-border bg-surface/60"
                      }`}
                    >
                      {turn.content}
                    </div>
                  ))
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Ask something a real caller would ask — pricing, hours, or availability.
                  </p>
                )}
                {thinking ? (
                  <p className="text-xs text-muted-foreground">Agent is replying…</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  placeholder="What are your charges for a cleaning?"
                />
                <Button onClick={send} disabled={thinking}>
                  <Send className="size-4" />
                </Button>
              </div>
            </div>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
