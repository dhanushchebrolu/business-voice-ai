import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, Pencil, Trash2, Plus, Send } from "lucide-react";
import {
  listKnowledgeBase,
  upsertKnowledgeEntry,
  setKnowledgeActive,
  deleteKnowledgeEntry,
} from "@/lib/website-ai-admin.functions";
import { listPlatformSettings, updatePlatformSetting } from "@/lib/admin.functions";
import { publicChat } from "@/lib/public-assistant.functions";
import {
  PageHeader,
  SectionCard,
  LoadingState,
  ErrorState,
  StatusPill,
} from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/admin/website-ai")({
  component: AdminWebsiteAi,
});

type KnowledgeRow = {
  id: string;
  title: string;
  content: string;
  category: string | null;
  is_active: boolean;
  sort_order: number;
};

const emptyDraft = {
  id: undefined as string | undefined,
  title: "",
  content: "",
  category: "",
  sortOrder: 0,
};

function AdminWebsiteAi() {
  const qc = useQueryClient();
  const fetchKnowledge = useServerFn(listKnowledgeBase);
  const saveKnowledge = useServerFn(upsertKnowledgeEntry);
  const toggleKnowledge = useServerFn(setKnowledgeActive);
  const removeKnowledge = useServerFn(deleteKnowledgeEntry);
  const fetchSettings = useServerFn(listPlatformSettings);
  const saveSetting = useServerFn(updatePlatformSetting);

  const [draft, setDraft] = useState<typeof emptyDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<KnowledgeRow | null>(null);
  const [settingTarget, setSettingTarget] = useState<{
    key: string;
    label: string;
    nextEnabled: boolean;
  } | null>(null);
  const [textTarget, setTextTarget] = useState<{
    key: string;
    label: string;
    current: string;
  } | null>(null);
  const [textValue, setTextValue] = useState("");

  const knowledgeQ = useQuery({
    queryKey: ["admin-website-knowledge"],
    queryFn: () => fetchKnowledge(),
  });
  const settingsQ = useQuery({
    queryKey: ["admin-website-ai-settings"],
    queryFn: () => fetchSettings(),
  });

  if (knowledgeQ.isLoading || settingsQ.isLoading)
    return <LoadingState label="Loading Website AI" />;
  if (knowledgeQ.error)
    return (
      <ErrorState
        message="Could not load knowledge base"
        onRetry={() => void knowledgeQ.refetch()}
      />
    );

  const settingsMap = new Map(
    (settingsQ.data ?? []).map((s) => [s.key, s.value as Record<string, unknown>]),
  );
  const chatbotEnabled = Boolean(
    (settingsMap.get("website_ai.chatbot_enabled") as { enabled?: boolean } | undefined)?.enabled ??
    true,
  );
  const voiceEnabled = Boolean(
    (settingsMap.get("website_ai.voice_enabled") as { enabled?: boolean } | undefined)?.enabled ??
    false,
  );
  const welcomeMessage =
    (settingsMap.get("website_ai.welcome_message") as { text?: string } | undefined)?.text ?? "";
  const fallbackResponse =
    (settingsMap.get("website_ai.fallback_response") as { text?: string } | undefined)?.text ?? "";

  const rows = (knowledgeQ.data ?? []) as KnowledgeRow[];

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    try {
      await saveKnowledge({
        data: {
          ...(draft.id ? { id: draft.id } : {}),
          title: draft.title,
          content: draft.content,
          category: draft.category || null,
          sortOrder: draft.sortOrder,
        },
      });
      toast.success(draft.id ? "Entry updated" : "Entry created");
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["admin-website-knowledge"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save entry");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Website AI"
        description="Manage the public chatbot/voice assistant's knowledge and behaviour. It can never see customer data."
      />

      <SectionCard
        title="Settings"
        description="Controls the public assistant embedded on the marketing site."
      >
        <ul className="divide-y divide-border">
          <li className="flex items-center justify-between gap-3 py-3">
            <div>
              <p className="text-sm font-medium">Public chatbot</p>
              <p className="text-xs text-muted-foreground">
                Shows the floating chat button on public pages.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill tone={chatbotEnabled ? "live" : "idle"}>
                {chatbotEnabled ? "On" : "Off"}
              </StatusPill>
              <Switch
                checked={chatbotEnabled}
                onCheckedChange={(v) =>
                  setSettingTarget({
                    key: "website_ai.chatbot_enabled",
                    label: "Public chatbot",
                    nextEnabled: v,
                  })
                }
              />
            </div>
          </li>
          <li className="flex items-center justify-between gap-3 py-3">
            <div>
              <p className="text-sm font-medium">Public voice assistant</p>
              <p className="text-xs text-muted-foreground">
                Requires SARVAM_API_KEY to be configured to actually speak.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill tone={voiceEnabled ? "live" : "idle"}>
                {voiceEnabled ? "On" : "Off"}
              </StatusPill>
              <Switch
                checked={voiceEnabled}
                onCheckedChange={(v) =>
                  setSettingTarget({
                    key: "website_ai.voice_enabled",
                    label: "Public voice assistant",
                    nextEnabled: v,
                  })
                }
              />
            </div>
          </li>
          <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">Welcome message</p>
              <p className="truncate text-xs text-muted-foreground">
                {welcomeMessage || "Using default"}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setTextTarget({
                  key: "website_ai.welcome_message",
                  label: "Welcome message",
                  current: welcomeMessage,
                });
                setTextValue(welcomeMessage);
              }}
            >
              Edit
            </Button>
          </li>
          <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">Fallback response</p>
              <p className="truncate text-xs text-muted-foreground">
                {fallbackResponse || "Using default"}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setTextTarget({
                  key: "website_ai.fallback_response",
                  label: "Fallback response",
                  current: fallbackResponse,
                });
                setTextValue(fallbackResponse);
              }}
            >
              Edit
            </Button>
          </li>
        </ul>
      </SectionCard>

      <SectionCard
        title="Knowledge base"
        description="The only content the public assistant can answer from."
        actions={
          <Button size="sm" onClick={() => setDraft({ ...emptyDraft })}>
            <Plus className="mr-1.5 size-3.5" /> Add entry
          </Button>
        }
      >
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No knowledge entries yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{row.title}</p>
                    {row.category ? (
                      <StatusPill tone="idle" dot={false}>
                        {row.category}
                      </StatusPill>
                    ) : null}
                    <StatusPill tone={row.is_active ? "live" : "idle"}>
                      {row.is_active ? "Active" : "Inactive"}
                    </StatusPill>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.content}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Switch
                    checked={row.is_active}
                    onCheckedChange={async (v) => {
                      await toggleKnowledge({ data: { id: row.id, isActive: v } });
                      await qc.invalidateQueries({ queryKey: ["admin-website-knowledge"] });
                    }}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() =>
                      setDraft({
                        id: row.id,
                        title: row.title,
                        content: row.content,
                        category: row.category ?? "",
                        sortOrder: row.sort_order,
                      })
                    }
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setToDelete(row)}>
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <PreviewPanel />

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit entry" : "New entry"}</DialogTitle>
          </DialogHeader>
          {draft ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Title</Label>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Category (optional)</Label>
                <Input
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  placeholder="e.g. pricing, features"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Content</Label>
                <Textarea
                  rows={5}
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Sort order</Label>
                <Input
                  type="number"
                  value={draft.sortOrder}
                  onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              onClick={saveDraft}
              disabled={saving || !draft?.title.trim() || !draft?.content.trim()}
            >
              {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{toDelete?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the entry from the public assistant's knowledge.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!toDelete) return;
                await removeKnowledge({ data: { id: toDelete.id } });
                setToDelete(null);
                await qc.invalidateQueries({ queryKey: ["admin-website-knowledge"] });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ReasonDialog
        open={settingTarget !== null}
        onOpenChange={(open) => !open && setSettingTarget(null)}
        title={`${settingTarget?.nextEnabled ? "Enable" : "Disable"} ${settingTarget?.label ?? ""}`}
        description="Applied immediately to the public website."
        onConfirm={async (reason) => {
          const target = settingTarget!;
          await saveSetting({
            data: { key: target.key, value: { enabled: target.nextEnabled }, reason },
          });
          toast.success("Setting updated");
          setSettingTarget(null);
          await qc.invalidateQueries({ queryKey: ["admin-website-ai-settings"] });
        }}
      />

      <ReasonDialog
        open={textTarget !== null}
        onOpenChange={(open) => !open && setTextTarget(null)}
        title={`Update ${textTarget?.label ?? ""}`}
        description="Shown to visitors of the public assistant."
        confirmLabel="Save"
        extra={
          <Textarea rows={3} value={textValue} onChange={(e) => setTextValue(e.target.value)} />
        }
        onConfirm={async (reason) => {
          const target = textTarget!;
          await saveSetting({ data: { key: target.key, value: { text: textValue }, reason } });
          toast.success("Setting updated");
          setTextTarget(null);
          await qc.invalidateQueries({ queryKey: ["admin-website-ai-settings"] });
        }}
      />
    </div>
  );
}

function PreviewPanel() {
  const sendChat = useServerFn(publicChat);
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!message.trim() || busy) return;
    const next = [...turns, { role: "user" as const, content: message.trim() }];
    setTurns(next);
    setMessage("");
    setBusy(true);
    try {
      const result = await sendChat({ data: { message: next.at(-1)!.content, history: turns } });
      setTurns([...next, { role: "assistant", content: result.reply }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Preview"
      description="Test the public chatbot exactly as a visitor would see it."
    >
      <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-border p-3">
        {turns.length === 0 ? (
          <p className="text-sm text-muted-foreground">Send a message to test the assistant.</p>
        ) : null}
        {turns.map((t, i) => (
          <p
            key={i}
            className={t.role === "user" ? "text-sm font-medium" : "text-sm text-muted-foreground"}
          >
            <span className="mr-1.5 text-xs uppercase tracking-wide text-muted-foreground/70">
              {t.role}
            </span>
            {t.content}
          </p>
        ))}
        {busy ? <p className="text-xs text-muted-foreground">Thinking…</p> : null}
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask something a visitor might ask…"
          onKeyDown={(e) => e.key === "Enter" && void send()}
        />
        <Button onClick={send} disabled={busy || !message.trim()}>
          <Send className="size-4" />
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Voice preview: use the floating widget on any public page (bottom-right) once voice is
        enabled and SARVAM_API_KEY is configured.
      </p>
    </SectionCard>
  );
}
