import { useState } from "react";
import { Loader2, Trash2, MessageSquareReply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { SectionCard, EmptyState } from "@/components/app/primitives";

/**
 * Minimal comment->DM automation UI (spec PART 11: "keep the rule table
 * simple... do NOT build a visual workflow builder, arbitrary rule DSL,
 * or complex automation graph"). One flat list, one flat add-rule form —
 * no drag-and-drop, no multi-step wizard, no condition graph.
 */

export interface InstagramAutomationRuleSummary {
  id: string;
  instagram_connection_id: string;
  name: string;
  trigger_type: string;
  trigger_config: { keywords?: string[]; postId?: string };
  action_type: string;
  action_config: { replyText?: string; dmText?: string };
  enabled: boolean;
}

interface Connection {
  id: string;
  username: string | null;
  instagram_business_account_id: string;
}

export function InstagramAutomationRules({
  connections,
  rules,
  saving,
  onSave,
  deletingId,
  onDelete,
  onToggle,
}: {
  connections: Connection[];
  rules: InstagramAutomationRuleSummary[];
  saving: boolean;
  onSave: (input: {
    instagramConnectionId: string;
    name: string;
    triggerType: "comment_keyword" | "comment_any";
    keywords: string;
    actionType: "public_reply" | "private_dm" | "ai_dm";
    replyText: string;
    dmText: string;
  }) => void;
  deletingId: string | null;
  onDelete: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const [connectionId, setConnectionId] = useState<string>(connections[0]?.id ?? "");
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<"comment_keyword" | "comment_any">(
    "comment_keyword",
  );
  const [keywords, setKeywords] = useState("");
  const [actionType, setActionType] = useState<"public_reply" | "private_dm" | "ai_dm">(
    "private_dm",
  );
  const [replyText, setReplyText] = useState("");
  const [dmText, setDmText] = useState("");

  if (connections.length === 0) return null;

  const canSave =
    connectionId &&
    name.trim() &&
    (triggerType === "comment_any" || keywords.trim()) &&
    (actionType !== "public_reply" || replyText.trim()) &&
    (actionType !== "private_dm" || dmText.trim());

  function handleSave() {
    onSave({
      instagramConnectionId: connectionId,
      name,
      triggerType,
      keywords,
      actionType,
      replyText,
      dmText,
    });
    setName("");
    setKeywords("");
    setReplyText("");
    setDmText("");
  }

  return (
    <SectionCard
      title="Comment automation"
      description="Automatically reply to or DM people who comment on your Instagram posts."
    >
      {rules.length === 0 ? (
        <EmptyState
          icon={MessageSquareReply}
          title="No automation rules yet"
          description="Add a rule below to reply to comments or send an automatic DM."
        />
      ) : (
        <div className="space-y-2">
          {rules.map((r) => {
            const conn = connections.find((c) => c.id === r.instagram_connection_id);
            return (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {conn?.username ? `@${conn.username}` : "Instagram"} ·{" "}
                    {r.trigger_type === "comment_keyword"
                      ? `keyword: ${(r.trigger_config.keywords ?? []).join(", ")}`
                      : "any comment"}{" "}
                    →{" "}
                    {r.action_type === "public_reply"
                      ? "public reply"
                      : r.action_type === "private_dm"
                        ? "private DM"
                        : "AI DM"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(checked) => onToggle(r.id, checked)}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={deletingId === r.id}
                    onClick={() => onDelete(r.id)}
                  >
                    {deletingId === r.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-5 space-y-3 rounded-lg border border-dashed border-border p-4">
        <p className="text-xs font-medium text-muted-foreground">Add a rule</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Instagram account</Label>
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.username ? `@${c.username}` : c.instagram_business_account_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Rule name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Price replies"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Trigger</Label>
            <Select
              value={triggerType}
              onValueChange={(v) => setTriggerType(v as typeof triggerType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="comment_keyword">Comment contains keyword</SelectItem>
                <SelectItem value="comment_any">Any comment</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {triggerType === "comment_keyword" ? (
            <div className="space-y-1.5">
              <Label>Keywords (comma-separated)</Label>
              <Input
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="price, cost, how much"
              />
            </div>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label>Action</Label>
          <Select value={actionType} onValueChange={(v) => setActionType(v as typeof actionType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public_reply">Post a public reply</SelectItem>
              <SelectItem value="private_dm">Send a fixed private DM</SelectItem>
              <SelectItem value="ai_dm">Let the AI agent reply by DM</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {actionType === "public_reply" ? (
          <div className="space-y-1.5">
            <Label>Public reply text</Label>
            <Textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={2} />
          </div>
        ) : null}
        {actionType === "private_dm" ? (
          <div className="space-y-1.5">
            <Label>DM text</Label>
            <Textarea value={dmText} onChange={(e) => setDmText(e.target.value)} rows={2} />
          </div>
        ) : null}
        {actionType === "ai_dm" ? (
          <p className="text-xs text-muted-foreground">
            The AI agent assigned to this account will generate and send a reply using your
            business's knowledge base and tools.
          </p>
        ) : null}

        <Button size="sm" onClick={handleSave} disabled={!canSave || saving}>
          {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Add rule
        </Button>
      </div>
    </SectionCard>
  );
}
