import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery } from "@/lib/workspace";
import { BUSINESS_TYPES, getBusinessType, DAYS } from "@/lib/business-types";
import { describeInvalidInterval } from "@/lib/calendar/business-hours-validation";
import {
  buildSetupPayload,
  formFromSaved,
  hasMixedHours,
  loadSetup,
  saveOnboarding,
  type SavedSetup,
} from "@/lib/onboarding-save";
import { LANGUAGES, VOICES } from "@/lib/voices";
import { Logo } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/onboarding")({
  head: () => ({
    meta: [
      { title: "Set up your receptionist — ClickAI" },
      {
        name: "description",
        content:
          "Tell ClickAI about your business so your AI receptionist can answer calls accurately.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Onboarding,
});

const STEPS = ["Business type", "Business details", "Hours", "Services", "Voice & greeting"];

/** Loads what is already saved before the form opens, so nothing is overwritten by blanks. */
function Onboarding() {
  const { user } = useAuth();
  const { data: ws, error: workspaceError, refetch } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const setup = useQuery({
    queryKey: ["onboarding-setup", orgId],
    enabled: Boolean(orgId),
    queryFn: () => loadSetup(supabase, orgId!),
    // Read afresh on every visit; never swapped under a form the person is filling in.
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const failed = workspaceError ?? setup.error;
  if (!orgId || !setup.data)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-5 text-sm text-muted-foreground">
        {failed ? (
          <>
            <p role="alert">We could not load your saved business details.</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void (workspaceError ? refetch() : setup.refetch())}
            >
              Try again
            </Button>
          </>
        ) : (
          <p className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading your saved details…
          </p>
        )}
      </div>
    );
  return <Wizard key={orgId} orgId={orgId} orgName={ws.organization!.name} saved={setup.data} />;
}

function Wizard({ orgId, orgName, saved }: { orgId: string; orgName: string; saved: SavedSetup }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  /** The form as it opened: only what differs from it counts as an edit. */
  const [loaded] = useState(() => formFromSaved(saved));
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  const [typeId, setTypeId] = useState(loaded.typeId);
  const type = useMemo(() => getBusinessType(typeId), [typeId]);
  const [info, setInfo] = useState(loaded.info);
  const [openTime, setOpenTime] = useState(loaded.openTime);
  const [closeTime, setCloseTime] = useState(loaded.closeTime);
  const [openDays, setOpenDays] = useState<number[]>(loaded.openDays);
  const [items, setItems] = useState(loaded.items);
  const [agentName, setAgentName] = useState(loaded.agentName);
  const [language, setLanguage] = useState(loaded.language);
  const [voiceId, setVoiceId] = useState(loaded.voiceId);
  const [greeting, setGreeting] = useState(loaded.greeting);

  const displayName = info.name || orgName;
  const defaultGreeting = `Thank you for calling ${displayName || "our business"}. This is ${agentName}. How may I help you today?`;

  function next() {
    if (step === 0 && !typeId) {
      toast.error("Choose the type of business you run.");
      return;
    }
    // An already saved description is accepted as it is.
    const keptDescription = loaded.info.description && info.description === loaded.info.description;
    if (
      step === 1 &&
      (!info.name.trim() || (info.description.trim().length < 40 && !keptDescription))
    ) {
      toast.error("Add your business name and a description of at least 40 characters.");
      return;
    }
    if (step === 2 && openDays.length > 0) {
      const validationError = describeInvalidInterval({ start: openTime, end: closeTime });
      if (validationError) {
        toast.error(validationError);
        return;
      }
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  async function finish() {
    setSaving(true);
    try {
      const form = {
        typeId,
        info,
        openDays,
        openTime,
        closeTime,
        items,
        agentName,
        language,
        voiceId,
        greeting,
      };
      const { createdAgent } = await saveOnboarding(
        supabase,
        orgId,
        buildSetupPayload(form, loaded, defaultGreeting),
      );
      await qc.invalidateQueries({ queryKey: ["workspace"] });
      toast.success(
        createdAgent
          ? "Workspace ready. Review and publish your receptionist."
          : "Your changes are saved.",
      );
      navigate({ to: "/app/agent" });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save your business. Please retry.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-5">
          <Logo />
          <span className="text-xs text-muted-foreground tabular">
            Step {step + 1} of {STEPS.length}
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-10">
        <div className="mb-8 flex gap-1.5">
          {STEPS.map((s, i) => (
            <div key={s} className="flex-1">
              <div className={cn("h-1 rounded-full", i <= step ? "bg-primary" : "bg-border")} />
              <p
                className={cn(
                  "mt-2 text-[11px]",
                  i <= step ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {s}
              </p>
            </div>
          ))}
        </div>

        {step === 0 ? (
          <section>
            <h1 className="text-2xl font-semibold tracking-tight">
              What type of business do you run?
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This decides which fields, terminology and starter rules your receptionist gets.
            </p>
            <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {BUSINESS_TYPES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTypeId(t.id)}
                  className={cn(
                    "rounded-lg border p-4 text-left transition-colors",
                    typeId === t.id
                      ? "border-primary/60 bg-primary/8"
                      : "border-border bg-card hover:border-border-strong",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{t.label}</span>
                    {typeId === t.id ? <Check className="size-3.5 text-primary" /> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.blurb}</p>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">Tell us about your business</h1>
            <p className="text-sm text-muted-foreground">
              The receptionist introduces itself using exactly this information.
            </p>
            <Row>
              <FieldBox label="Business name">
                <Input
                  value={info.name}
                  onChange={(e) => setInfo({ ...info, name: e.target.value })}
                  placeholder="Smile Dental"
                />
              </FieldBox>
              <FieldBox label="Primary phone">
                <Input
                  value={info.primary_phone}
                  onChange={(e) => setInfo({ ...info, primary_phone: e.target.value })}
                  placeholder="+91 98765 43210"
                />
              </FieldBox>
            </Row>
            <FieldBox
              label="How should the AI describe your business?"
              hint={`${info.description.length} / 3000 characters`}
            >
              <Textarea
                rows={5}
                maxLength={3000}
                value={info.description}
                onChange={(e) => setInfo({ ...info, description: e.target.value })}
                placeholder={`Describe your ${type.label.toLowerCase()}: what you offer, who you serve and where you are.`}
              />
            </FieldBox>
            <Row>
              <FieldBox label="Address">
                <Input
                  value={info.address}
                  onChange={(e) => setInfo({ ...info, address: e.target.value })}
                />
              </FieldBox>
              <FieldBox label="City">
                <Input
                  value={info.city}
                  onChange={(e) => setInfo({ ...info, city: e.target.value })}
                />
              </FieldBox>
            </Row>
            <Row>
              <FieldBox label="State">
                <Input
                  value={info.state}
                  onChange={(e) => setInfo({ ...info, state: e.target.value })}
                />
              </FieldBox>
              <FieldBox label="PIN code">
                <Input
                  value={info.postal_code}
                  onChange={(e) => setInfo({ ...info, postal_code: e.target.value })}
                />
              </FieldBox>
            </Row>
            <Row>
              <FieldBox label="Email">
                <Input
                  value={info.email}
                  onChange={(e) => setInfo({ ...info, email: e.target.value })}
                />
              </FieldBox>
              <FieldBox label="Website">
                <Input
                  value={info.website}
                  onChange={(e) => setInfo({ ...info, website: e.target.value })}
                />
              </FieldBox>
            </Row>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="space-y-5">
            <h1 className="text-2xl font-semibold tracking-tight">When are you open?</h1>
            <p className="text-sm text-muted-foreground">
              The agent will never claim you are open outside these hours. You can add breaks and
              holidays later.
            </p>
            {hasMixedHours(saved) ? (
              <p className="text-sm text-muted-foreground" role="note">
                Your saved days have different hours. They stay as they are unless you change the
                days or times here.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  onClick={() =>
                    setOpenDays((prev) =>
                      prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i],
                    )
                  }
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm",
                    openDays.includes(i)
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {d.slice(0, 3)}
                </button>
              ))}
            </div>
            <Row>
              <FieldBox label="Opening time">
                <Input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} />
              </FieldBox>
              <FieldBox label="Closing time">
                <Input
                  type="time"
                  value={closeTime}
                  onChange={(e) => setCloseTime(e.target.value)}
                />
              </FieldBox>
            </Row>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">
              Add a few {type.itemLabelPlural.toLowerCase()}
            </h1>
            <p className="text-sm text-muted-foreground">
              The agent only quotes prices you enter here. You can add the full catalogue after
              setup.
            </p>
            {items.map((item, idx) => (
              <Row key={idx}>
                <FieldBox label={`${type.itemLabel} ${idx + 1}`}>
                  <Input
                    value={item.name}
                    onChange={(e) =>
                      setItems(
                        items.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)),
                      )
                    }
                    placeholder={idx === 0 ? "Root canal treatment" : ""}
                  />
                </FieldBox>
                <FieldBox label="Price (₹)">
                  <Input
                    inputMode="decimal"
                    value={item.price}
                    onChange={(e) =>
                      setItems(
                        items.map((x, i) => (i === idx ? { ...x, price: e.target.value } : x)),
                      )
                    }
                    placeholder="5000"
                  />
                </FieldBox>
              </Row>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setItems([...items, { name: "", price: "" }])}
            >
              Add another
            </Button>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">
              Give your receptionist a voice
            </h1>
            <Row>
              <FieldBox label="Agent name">
                <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} />
              </FieldBox>
              <FieldBox label="Primary language">
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.some((l) => l.code === language) ? null : (
                      <SelectItem value={language}>{language}</SelectItem>
                    )}
                    {LANGUAGES.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label} — {l.native}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldBox>
            </Row>
            <FieldBox label="Voice">
              <Select value={voiceId} onValueChange={setVoiceId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {VOICES.some((v) => v.id === voiceId) ? null : (
                    <SelectItem value={voiceId}>{voiceId}</SelectItem>
                  )}
                  {VOICES.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} · {v.gender}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldBox>
            <FieldBox label="Call greeting" hint="Leave blank to use the suggested greeting.">
              <Textarea
                rows={3}
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                placeholder={defaultGreeting}
              />
            </FieldBox>
          </section>
        ) : null}

        <div className="mt-10 flex items-center justify-between border-t border-border pt-6">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || saving}
          >
            <ArrowLeft className="mr-1.5 size-4" /> Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={next}>
              Continue <ArrowRight className="ml-1.5 size-4" />
            </Button>
          ) : (
            <Button onClick={finish} disabled={saving}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}Finish setup
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function FieldBox({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
