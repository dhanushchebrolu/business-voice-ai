import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { workspaceQuery, knowledgeQuery, type KnowledgeRow } from "@/lib/workspace";
import {
  KNOWLEDGE_CATEGORIES,
  isKnowledgeEnabled,
  KNOWLEDGE_ENABLED_STATUS,
  KNOWLEDGE_DISABLED_STATUS,
  type KnowledgeCategory,
} from "@/lib/knowledge-categories";
import { PageHeader, SectionCard, LoadingState, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

export const Route = createFileRoute("/app/knowledge")({
  head: () => ({
    meta: [
      { title: "Knowledge base — Vaani" },
      {
        name: "description",
        content:
          "Staff, policies, appointment guidance and other details your AI receptionist can draw on during calls.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: KnowledgePage,
});

function KnowledgePage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: ws, isLoading: wsLoading } = useQuery(workspaceQuery(user?.id));
  const business = ws?.business ?? null;
  const { data: docs, isLoading: docsLoading } = useQuery(knowledgeQuery(business?.id));

  const [deleteTarget, setDeleteTarget] = useState<KnowledgeRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["knowledge", business?.id] });

  if (wsLoading || !business) return <LoadingState label="Loading knowledge base" />;

  async function addDocument(
    category: KnowledgeCategory,
    values: { title: string; content: string },
  ) {
    if (!business) return;
    const { error } = await supabase.from("knowledge_documents").insert({
      organization_id: business.organization_id,
      business_id: business.id,
      title: values.title.trim(),
      content: values.content.trim(),
      source_type: category,
      status: KNOWLEDGE_ENABLED_STATUS,
    } as never);
    if (error) {
      toast.error("Could not add that entry.");
      return;
    }
    toast.success("Added. Publish your receptionist to apply it to calls.");
    refresh();
  }

  async function saveDocument(id: string, values: { title: string; content: string }) {
    const { error } = await supabase
      .from("knowledge_documents")
      .update({ title: values.title.trim(), content: values.content.trim() })
      .eq("id", id);
    if (error) {
      toast.error("Could not save changes.");
      return false;
    }
    toast.success("Saved. Publish your receptionist to apply it to calls.");
    refresh();
    return true;
  }

  async function toggleDocument(row: KnowledgeRow) {
    const nextStatus = isKnowledgeEnabled(row.status)
      ? KNOWLEDGE_DISABLED_STATUS
      : KNOWLEDGE_ENABLED_STATUS;
    const { error } = await supabase
      .from("knowledge_documents")
      .update({ status: nextStatus })
      .eq("id", row.id);
    if (error) {
      toast.error("Could not update that entry.");
      return;
    }
    refresh();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from("knowledge_documents").delete().eq("id", deleteTarget.id);
    setDeleting(false);
    if (error) {
      toast.error("Could not delete that entry.");
      return;
    }
    toast.success("Deleted.");
    setDeleteTarget(null);
    refresh();
  }

  const allDocs = docs ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge base"
        description="Staff, policies, appointment guidance and other details your receptionist can reference on calls. Disabled entries are never used. Publish your AI receptionist to apply changes to live calls."
      />

      <Tabs defaultValue={KNOWLEDGE_CATEGORIES[0].value}>
        <TabsList>
          {KNOWLEDGE_CATEGORIES.map((c) => (
            <TabsTrigger key={c.value} value={c.value}>
              {c.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {KNOWLEDGE_CATEGORIES.map((c) => (
          <TabsContent key={c.value} value={c.value} className="mt-4">
            <CategoryPanel
              category={c.value}
              label={c.label}
              docs={allDocs.filter((d) => d.source_type === c.value)}
              loading={docsLoading}
              onAdd={(values) => addDocument(c.value, values)}
              onSave={saveDocument}
              onToggle={toggleDocument}
              onRequestDelete={setDeleteTarget}
            />
          </TabsContent>
        ))}
      </Tabs>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `"${deleteTarget.title}" will be permanently removed and will no longer be available to your receptionist.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CategoryPanel({
  category,
  label,
  docs,
  loading,
  onAdd,
  onSave,
  onToggle,
  onRequestDelete,
}: {
  category: KnowledgeCategory;
  label: string;
  docs: KnowledgeRow[];
  loading: boolean;
  onAdd: (values: { title: string; content: string }) => void | Promise<void>;
  onSave: (id: string, values: { title: string; content: string }) => Promise<boolean>;
  onToggle: (row: KnowledgeRow) => void | Promise<void>;
  onRequestDelete: (row: KnowledgeRow) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ title: "", content: "" });
  const [newValues, setNewValues] = useState({ title: "", content: "" });
  const [adding, setAdding] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  return (
    <SectionCard
      title={label}
      description={`Only what you add here is used for ${label.toLowerCase()} questions. Nothing is invented.`}
    >
      {loading ? (
        <LoadingState label="Loading" />
      ) : docs.length ? (
        <ul className="divide-y divide-border">
          {docs.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="space-y-3 py-3">
                <Input
                  value={editValues.title}
                  placeholder="Title"
                  onChange={(e) => setEditValues({ ...editValues, title: e.target.value })}
                />
                <Textarea
                  rows={4}
                  value={editValues.content}
                  placeholder="Details"
                  onChange={(e) => setEditValues({ ...editValues, content: e.target.value })}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingId(null)}
                    disabled={savingEdit}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={savingEdit || !editValues.title.trim() || !editValues.content.trim()}
                    onClick={async () => {
                      setSavingEdit(true);
                      const ok = await onSave(row.id, editValues);
                      setSavingEdit(false);
                      if (ok) setEditingId(null);
                    }}
                  >
                    {savingEdit ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                    Save
                  </Button>
                </div>
              </li>
            ) : (
              <li key={row.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{row.title}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{row.content}</p>
                  {!isKnowledgeEnabled(row.status) ? (
                    <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Disabled — not used on calls
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Switch
                    checked={isKnowledgeEnabled(row.status)}
                    onCheckedChange={() => onToggle(row)}
                    aria-label={isKnowledgeEnabled(row.status) ? "Disable" : "Enable"}
                  />
                  <button
                    onClick={() => {
                      setEditingId(row.id);
                      setEditValues({ title: row.title, content: row.content ?? "" });
                    }}
                    aria-label="Edit"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    onClick={() => onRequestDelete(row)}
                    aria-label="Delete"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      ) : (
        <EmptyState
          icon={BookOpen}
          title={`No ${label.toLowerCase()} added yet`}
          description={`Add ${label.toLowerCase()} details below so your receptionist can answer questions about them.`}
        />
      )}

      <div className="mt-4 space-y-3 border-t border-border pt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title">
            <Input
              value={newValues.title}
              placeholder={`e.g. ${label} — ${category}`}
              onChange={(e) => setNewValues({ ...newValues, title: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Details">
          <Textarea
            rows={3}
            value={newValues.content}
            placeholder="What should your receptionist know?"
            onChange={(e) => setNewValues({ ...newValues, content: e.target.value })}
          />
        </Field>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={adding || !newValues.title.trim() || !newValues.content.trim()}
            onClick={async () => {
              setAdding(true);
              await onAdd(newValues);
              setAdding(false);
              setNewValues({ title: "", content: "" });
            }}
          >
            {adding ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 size-3.5" />
            )}
            Add {label.toLowerCase()}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
