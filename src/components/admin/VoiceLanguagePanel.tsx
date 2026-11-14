import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  getVoiceLanguageSettings,
  markVoiceLanguageApplied,
  saveVoiceLanguageSettings,
} from "@/lib/voice-language-settings.functions";
import {
  ALWAYS_ALLOWED,
  MAX_EXTRA_REGIONAL,
  SARVAM_LANGUAGES,
  findSarvamVoice,
  suggestVoiceLanguageDefaults,
  voicesForLanguages,
  type SarvamLanguageName,
} from "@/lib/sarvam-voice-catalog";
import { SARVAM_VOICE_CATALOG_CAPTURED_ON } from "@/lib/sarvam-voice-catalog.data";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Onboarding-team control for a customer's Sarvam agent voice and languages.
 * Saving records the wanted settings ("Pending"); the ClickAI team then
 * applies the shown config to the customer's own Sarvam agent, commits it,
 * maps that version, and records it here ("Applied"). Nothing here changes
 * the Sarvam agent by itself — Sarvam has no unattended API for that.
 */
export function VoiceLanguagePanel({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const fetchSettings = useServerFn(getVoiceLanguageSettings);
  const save = useServerFn(saveVoiceLanguageSettings);
  const markApplied = useServerFn(markVoiceLanguageApplied);
  const state = useQuery({
    queryKey: ["admin-voice-language", orgId],
    queryFn: () => fetchSettings({ data: { orgId } }),
  });

  const [defaultLanguage, setDefaultLanguage] = useState<SarvamLanguageName>("English");
  const [extras, setExtras] = useState<SarvamLanguageName[]>([]);
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [voiceId, setVoiceId] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [appliedOpen, setAppliedOpen] = useState(false);
  const [appliedVersion, setAppliedVersion] = useState("");
  const [lastConfig, setLastConfig] = useState<unknown>(null);

  const settings = state.data?.settings ?? null;
  const primaryLanguage = state.data?.agent?.primary_language ?? null;
  // Nothing saved yet: start from the customer's main language and a native v4 voice.
  useEffect(() => {
    if (settings || !state.data) return;
    const suggested = suggestVoiceLanguageDefaults(primaryLanguage);
    setDefaultLanguage(suggested.defaultLanguage);
    setVoiceId(suggested.voiceInternalId ?? "");
  }, [settings, state.data, primaryLanguage]);
  useEffect(() => {
    if (!settings) return;
    setDefaultLanguage(settings.default_language as SarvamLanguageName);
    setExtras(
      settings.allowed_languages.filter(
        (l) => l !== settings.default_language && !ALWAYS_ALLOWED.includes(l as SarvamLanguageName),
      ) as SarvamLanguageName[],
    );
    setAutoSwitch(settings.auto_language_switch);
    setVoiceId(settings.sarvam_voice_internal_id);
  }, [settings]);

  const allowed = useMemo(
    () => [...new Set([defaultLanguage, ...ALWAYS_ALLOWED, ...extras])],
    [defaultLanguage, extras],
  );
  const voices = useMemo(() => voicesForLanguages(allowed), [allowed]);
  const voice = voiceId ? findSarvamVoice(voiceId) : undefined;
  const voiceFits = voice
    ? allowed.every((l) => voice.languages.includes(l)) && voice.model === "v4"
    : false;

  const toggleExtra = (l: SarvamLanguageName, on: boolean) =>
    setExtras((cur) => (on ? [...cur, l] : cur.filter((x) => x !== l)));

  const agent = state.data?.agent ?? null;
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["admin-voice-language", orgId] }),
      // The provisioning detail page shows the same settings and gates on them.
      qc.invalidateQueries({ queryKey: ["admin-provisioning-detail", orgId] }),
    ]);

  return (
    <SectionCard
      title="Voice & language (Sarvam agent)"
      description="Set during onboarding by the ClickAI team. Customers do not see these controls yet."
    >
      {state.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : state.error ? (
        <p className="text-sm text-destructive">{(state.error as Error).message}</p>
      ) : !agent ? (
        <p className="text-sm text-muted-foreground">This customer has no agent yet.</p>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              tone={settings?.status === "applied" ? "live" : settings ? "ready" : "idle"}
            >
              {settings?.status === "applied"
                ? `Applied to Sarvam agent ${settings.applied_sarvam_app_id ?? "unknown"} version ${settings.applied_sarvam_app_version}`
                : settings
                  ? "Pending — not yet applied to the Sarvam agent"
                  : "Not configured"}
            </StatusPill>
            <span className="text-muted-foreground">
              Agent mapped to Sarvam {agent.sarvam_app_id ?? "—"} v{agent.sarvam_app_version ?? "—"}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="font-medium">Default language</span>
              <Select
                value={defaultLanguage}
                onValueChange={(v) => {
                  setDefaultLanguage(v as SarvamLanguageName);
                  setExtras((cur) => cur.filter((x) => x !== v));
                }}
              >
                <SelectTrigger aria-label="Default language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SARVAM_LANGUAGES.map((l) => (
                    <SelectItem key={l.name} value={l.name}>
                      {l.name} · {l.native}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 self-end">
              <Switch
                checked={autoSwitch}
                onCheckedChange={setAutoSwitch}
                aria-label="Automatic language switching"
              />
              <span>
                Automatic language switching{" "}
                {autoSwitch ? "on" : "off (agent stays in the default language)"}
              </span>
            </label>
          </div>

          <fieldset className="space-y-2">
            <legend className="font-medium">
              Extra regional languages (up to {MAX_EXTRA_REGIONAL}; English and Hindi are always
              included)
            </legend>
            <div className="flex flex-wrap gap-3">
              {SARVAM_LANGUAGES.filter(
                (l) => l.name !== defaultLanguage && !ALWAYS_ALLOWED.includes(l.name),
              ).map((l) => {
                const on = extras.includes(l.name);
                return (
                  <label key={l.name} className="flex items-center gap-1.5">
                    <Checkbox
                      checked={on}
                      disabled={!on && extras.length >= MAX_EXTRA_REGIONAL}
                      onCheckedChange={(v) => toggleExtra(l.name, v === true)}
                    />
                    {l.name}
                  </label>
                );
              })}
            </div>
            <p className="text-muted-foreground">Agent languages: {allowed.join(", ")}</p>
          </fieldset>

          <label className="block space-y-1">
            <span className="font-medium">
              Voice ({voices.length} v4 voices support all of these languages)
            </span>
            <Select value={voiceId} onValueChange={setVoiceId}>
              <SelectTrigger aria-label="Voice">
                <SelectValue placeholder="Choose a voice" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {voices.map((v) => (
                  <SelectItem key={v.internalId} value={v.internalId}>
                    {v.name} · {v.gender} · native {v.nativeLanguages.join("/")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {voice ? (
              <p className={voiceFits ? "text-muted-foreground" : "text-destructive"}>
                {voiceFits
                  ? voice.description
                  : `${voice.name} does not support every selected language.`}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Catalog snapshot from Sarvam, {SARVAM_VOICE_CATALOG_CAPTURED_ON}. Preview voices in
              the Sarvam console.
            </p>
          </label>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!voiceFits} onClick={() => setSaveOpen(true)}>
              Save settings
            </Button>
            {settings?.status === "pending" ? (
              <Button size="sm" variant="outline" onClick={() => setAppliedOpen(true)}>
                Record as applied in Sarvam
              </Button>
            ) : null}
          </div>

          {lastConfig ? (
            <div className="space-y-1">
              <p className="font-medium">
                Apply this to the customer's Sarvam agent, then commit and map the new version:
              </p>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(lastConfig, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      )}

      <ReasonDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save voice & language"
        description="Saves the settings as pending. The Sarvam agent does not change until the ClickAI team applies and commits them."
        onConfirm={async (reason) => {
          const result = await save({
            data: {
              orgId,
              agentConfigId: agent!.id,
              defaultLanguage,
              allowedLanguages: allowed,
              autoLanguageSwitch: autoSwitch,
              voiceInternalId: voiceId,
              reason,
            },
          });
          setLastConfig(result.sarvamConfig);
          for (const w of result.warnings) toast.warning(w);
          toast.success("Saved as pending.");
          await refresh();
        }}
      />
      <ReasonDialog
        open={appliedOpen}
        onOpenChange={setAppliedOpen}
        title="Record as applied"
        description="Confirm the committed Sarvam agent version that carries these settings. It must be the version mapped to this customer's agent."
        extra={
          <Input
            inputMode="numeric"
            placeholder="Sarvam agent version, e.g. 6"
            value={appliedVersion}
            onChange={(e) => setAppliedVersion(e.target.value)}
          />
        }
        onConfirm={async (reason) => {
          await markApplied({ data: { orgId, sarvamAppVersion: Number(appliedVersion), reason } });
          toast.success("Recorded as applied.");
          await refresh();
        }}
      />
    </SectionCard>
  );
}
