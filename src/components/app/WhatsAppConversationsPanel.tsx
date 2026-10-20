import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MessageCircle, Loader2 } from "lucide-react";
import { SectionCard, StatusPill, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  listWhatsAppConversations,
  listWhatsAppMessages,
  setWhatsAppConversationAi,
  sendWhatsAppStaffReply,
} from "@/lib/whatsapp-conversations.functions";

/**
 * WhatsApp inbox: recent conversations, the selected conversation's messages
 * (with delivery status), the AI on/off switch (human handoff) and a staff
 * reply box. All data comes from server functions scoped to the signed-in
 * user's own organization; nothing here holds credentials.
 */
export function WhatsAppConversationsPanel({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const getConversations = useServerFn(listWhatsAppConversations);
  const getMessages = useServerFn(listWhatsAppMessages);
  const setAi = useServerFn(setWhatsAppConversationAi);
  const sendReply = useServerFn(sendWhatsAppStaffReply);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [togglingAi, setTogglingAi] = useState(false);

  const { data: conversations } = useQuery({
    queryKey: ["whatsapp-conversations", orgId],
    queryFn: () => getConversations(),
    refetchInterval: 15_000,
  });
  const selected = conversations?.find((c) => c.id === selectedId) ?? null;
  const { data: messages, isLoading: loadingMessages } = useQuery({
    queryKey: ["whatsapp-messages", orgId, selectedId],
    queryFn: () => getMessages({ data: { conversationId: selectedId as string } }),
    enabled: Boolean(selectedId),
    refetchInterval: 10_000,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["whatsapp-conversations", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["whatsapp-messages", orgId, selectedId] }),
    ]);

  const onToggleAi = async (enabled: boolean) => {
    if (!selected) return;
    setTogglingAi(true);
    try {
      await setAi({ data: { conversationId: selected.id, enabled } });
      toast.success(
        enabled ? "AI replies turned back on." : "AI paused — you're handling this chat.",
      );
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change AI replies.");
    } finally {
      setTogglingAi(false);
    }
  };

  const onSend = async () => {
    if (!selected || !draft.trim()) return;
    setSending(true);
    try {
      const result = await sendReply({
        data: { conversationId: selected.id, body: draft, clientRequestId: crypto.randomUUID() },
      });
      if (result.ok) {
        setDraft("");
        toast.success("Reply sent. AI replies are paused for this chat.");
      } else {
        toast.error(result.message);
      }
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the reply.");
    } finally {
      setSending(false);
    }
  };

  return (
    <SectionCard
      title="Conversations"
      description="Customer chats on your connected WhatsApp numbers. Your AI agent answers unless you take over."
    >
      {!conversations || conversations.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="No WhatsApp conversations yet"
          description="When a customer messages your connected number, the conversation appears here."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,260px)_1fr]">
          <ul className="max-h-[480px] space-y-1 overflow-y-auto">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                    c.id === selectedId ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">
                      {c.customer_display_name ?? `+${c.wa_id}`}
                    </span>
                    {c.handoff_requested_at && !c.ai_enabled ? (
                      <StatusPill tone="error">Needs a person</StatusPill>
                    ) : c.ai_enabled ? (
                      <StatusPill tone="live">AI</StatusPill>
                    ) : (
                      <StatusPill tone="idle">Staff</StatusPill>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.last_message_preview ?? "—"}
                  </p>
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <div className="flex min-h-[320px] flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm">
                  <p className="font-medium">
                    {selected.customer_display_name ?? `+${selected.wa_id}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selected.windowOpen
                      ? "Within WhatsApp's 24-hour reply window."
                      : "Outside WhatsApp's 24-hour window — free-text replies can't be sent until the customer writes again."}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  AI replies
                  <Switch
                    checked={selected.ai_enabled}
                    disabled={togglingAi}
                    onCheckedChange={onToggleAi}
                  />
                </label>
              </div>

              <div className="max-h-[360px] flex-1 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
                {loadingMessages ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  messages?.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                        m.direction === "inbound" ? "bg-muted" : "ml-auto bg-primary/10"
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{m.content ?? `[${m.message_type}]`}</p>
                      {m.direction === "outbound" ? (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {m.status}
                          {m.status === "failed" && m.error_message ? ` — ${m.error_message}` : ""}
                        </p>
                      ) : null}
                    </div>
                  ))
                )}
              </div>

              <div className="flex gap-2">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={4096}
                  placeholder={selected.windowOpen ? "Type a reply…" : "Reply window closed"}
                  disabled={!selected.windowOpen || sending}
                  rows={2}
                />
                <Button
                  onClick={onSend}
                  disabled={!selected.windowOpen || sending || !draft.trim()}
                >
                  {sending ? <Loader2 className="size-3.5 animate-spin" /> : "Send"}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Select a conversation.</p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
