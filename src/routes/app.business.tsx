import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  workspaceQuery,
  servicesQuery,
  faqsQuery,
  rulesQuery,
  hoursQuery,
  type HoursRow as BusinessHoursRecord,
} from "@/lib/workspace";
import { getBusinessType, DAYS } from "@/lib/business-types";
import {
  describeInvalidInterval,
  describeBusinessHoursWriteError,
} from "@/lib/calendar/business-hours-validation";
import { PageHeader, SectionCard, LoadingState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const DEFAULT_HOURS_INTERVAL = { start: "09:00", end: "19:00" };

export const Route = createFileRoute("/app/business")({
  head: () => ({
    meta: [
      { title: "Business profile — ClickAI" },
      { name: "description", content: "Business information, hours, services, FAQs and rules that ground your AI receptionist." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: BusinessPage,
});

function BusinessPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: ws, isLoading } = useQuery(workspaceQuery(user?.id));
  const business = ws?.business ?? null;
  const type = getBusinessType(business?.business_type);
  const { data: services } = useQuery(servicesQuery(business?.id));
  const { data: faqs } = useQuery(faqsQuery(business?.id));
  const { data: rules } = useQuery(rulesQuery(business?.id));
  const { data: hours } = useQuery(hoursQuery(business?.id));

  const [profile, setProfile] = useState({ name: "", description: "", address: "", city: "", primary_phone: "", email: "", website: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (business) {
      setProfile({
        name: business.name,
        description: business.description ?? "",
        address: business.address ?? "",
        city: business.city ?? "",
        primary_phone: business.primary_phone ?? "",
        email: business.email ?? "",
        website: business.website ?? "",
      });
    }
  }, [business]);

  if (isLoading || !business) return <LoadingState label="Loading business profile" />;

  const refresh = () => qc.invalidateQueries();

  async function saveProfile() {
    if (!business) return;
    setSaving(true);
    const { error } = await supabase.from("businesses").update(profile).eq("id", business.id);
    setSaving(false);
    if (error) {
      toast.error("Could not save changes.");
      return;
    }
    toast.success("Business profile saved. Publish your receptionist to apply it to calls.");
    refresh();
  }

  async function addRow(table: "services" | "faqs" | "business_rules", values: Record<string, unknown>) {
    if (!business) return;
    const { error } = await supabase
      .from(table)
      .insert({ organization_id: business.organization_id, business_id: business.id, ...values } as never);
    if (error) {
      toast.error("Could not add that entry.");
      return;
    }
    refresh();
  }

  async function removeRow(table: "services" | "faqs" | "business_rules", id: string) {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) {
      toast.error("Could not delete that entry.");
      return;
    }
    refresh();
  }

  async function toggleDay(row: BusinessHoursRecord | undefined, open: boolean) {
    if (!row) return;
    const stored = (row.intervals as { start: string; end: string }[] | null)?.[0];
    // Reopening never re-persists a stored interval that's already invalid
    // (e.g. a legacy {"start":"23:59","end":"00:00"} row) — that would
    // immediately fail the same validation a fresh write to this row now
    // goes through, leaving the day stuck closed. Falling back to the
    // known-good default instead means reopening always succeeds, and the
    // row is then editable again via the two time inputs below.
    const safeInterval =
      stored && !describeInvalidInterval(stored) ? stored : DEFAULT_HOURS_INTERVAL;
    const { error } = await supabase
      .from("business_hours")
      .update({ is_closed: !open, intervals: open ? [safeInterval] : [] })
      .eq("id", row.id);
    if (error) {
      toast.error(describeBusinessHoursWriteError(error) ?? error.message);
      return;
    }
    refresh();
  }

  async function saveInterval(
    row: BusinessHoursRecord | undefined,
    interval: { start: string; end: string },
  ) {
    if (!row) return;
    const validationError = describeInvalidInterval(interval);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    const { error } = await supabase
      .from("business_hours")
      .update({ intervals: [interval] })
      .eq("id", row.id);
    if (error) {
      toast.error(describeBusinessHoursWriteError(error) ?? error.message);
      return;
    }
    refresh();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Business profile"
        description={`Everything here is compiled into your receptionist's instructions. It never invents ${type.itemLabelPlural.toLowerCase()} or prices you haven't entered.`}
      />

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="hours">Hours</TabsTrigger>
          <TabsTrigger value="services">{type.itemLabelPlural}</TabsTrigger>
          <TabsTrigger value="faqs">FAQs</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <SectionCard
            title="Business information"
            description="Used for the introduction, address questions and contact details."
            actions={
              <Button size="sm" onClick={saveProfile} disabled={saving}>
                {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}Save
              </Button>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Business name">
                <Input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
              </Field>
              <Field label="Primary phone">
                <Input value={profile.primary_phone} onChange={(e) => setProfile({ ...profile, primary_phone: e.target.value })} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Description">
                  <Textarea rows={5} value={profile.description} onChange={(e) => setProfile({ ...profile, description: e.target.value })} />
                </Field>
              </div>
              <Field label="Address">
                <Input value={profile.address} onChange={(e) => setProfile({ ...profile, address: e.target.value })} />
              </Field>
              <Field label="City">
                <Input value={profile.city} onChange={(e) => setProfile({ ...profile, city: e.target.value })} />
              </Field>
              <Field label="Email">
                <Input value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
              </Field>
              <Field label="Website">
                <Input value={profile.website} onChange={(e) => setProfile({ ...profile, website: e.target.value })} />
              </Field>
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="hours" className="mt-4">
          <SectionCard title="Opening hours" description="The receptionist answers hour questions strictly from this table.">
            <ul className="divide-y divide-border">
              {DAYS.map((day, i) => {
                const row = hours?.find((h) => h.day_of_week === i);
                return (
                  <HoursRow
                    key={day}
                    day={day}
                    row={row}
                    onToggle={(open) => void toggleDay(row, open)}
                    onSaveInterval={(interval) => void saveInterval(row, interval)}
                  />
                );
              })}
            </ul>
          </SectionCard>
        </TabsContent>

        <TabsContent value="services" className="mt-4">
          <ListEditor
            title={type.itemLabelPlural}
            description={`Only these ${type.itemLabelPlural.toLowerCase()} and prices may be quoted on calls.`}
            fields={[
              { key: "name", label: type.itemLabel, placeholder: "Name" },
              { key: "price", label: "Price", placeholder: "5000", numeric: true },
              { key: "description", label: "Details", placeholder: "Optional details" },
            ]}
            rows={(services ?? []).map((s) => ({
              id: s.id,
              primary: s.name,
              secondary: [s.price ? `₹${s.price}` : null, s.description].filter(Boolean).join(" · "),
            }))}
            onAdd={async (v) => {
              await addRow("services", {
                name: String(v["name"]),
                price: v["price"] ? Number(v["price"]) : null,
                description: v["description"] || null,
              });
            }}
            onRemove={async (id) => {
              await removeRow("services", id);
            }}
          />
        </TabsContent>

        <TabsContent value="faqs" className="mt-4">
          <ListEditor
            title="Frequently asked questions"
            description="Answered verbatim in the caller's language."
            fields={[
              { key: "question", label: "Question", placeholder: "Do you accept walk-ins?" },
              { key: "answer", label: "Answer", placeholder: "We prefer appointments but keep two walk-in slots daily." },
            ]}
            rows={(faqs ?? []).map((f) => ({ id: f.id, primary: f.question, secondary: f.answer }))}
            onAdd={async (v) => {
              await addRow("faqs", { question: String(v["question"]), answer: String(v["answer"]) });
            }}
            onRemove={async (id) => {
              await removeRow("faqs", id);
            }}
          />
        </TabsContent>

        <TabsContent value="rules" className="mt-4">
          <ListEditor
            title="Rules and boundaries"
            description="Hard constraints the receptionist must follow on every call."
            fields={[{ key: "rule", label: "Rule", placeholder: "Never give medical advice over the phone." }]}
            rows={(rules ?? []).map((r) => ({ id: r.id, primary: r.rule, secondary: `Priority ${r.priority}` }))}
            onAdd={async (v) => {
              await addRow("business_rules", { rule: String(v["rule"]), priority: (rules?.length ?? 0) + 1 });
            }}
            onRemove={async (id) => {
              await removeRow("business_rules", id);
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * One weekday's hours row. Owns a local draft of {start, end} so a staff
 * member can retype BOTH fields before either one is persisted — the
 * previous per-keystroke-submits-one-field behavior meant a legacy-invalid
 * stored interval (production has rows shaped exactly {"start":"23:59",
 * "end":"00:00"}) could never be fixed through this editor: editing start
 * alone always re-submits it against the still-"00:00" end (nothing is
 * less than "00:00"), and editing end alone always re-submits it against
 * the still-"23:59" start (nothing is greater than "23:59") — so neither
 * single-field edit could ever pass validation. Buffering both fields
 * locally and committing once, on blur of the pair (not of either input
 * individually), lets the two edits land together in one validated write.
 */
function HoursRow({
  day,
  row,
  onToggle,
  onSaveInterval,
}: {
  day: string;
  row: BusinessHoursRecord | undefined;
  onToggle: (open: boolean) => void;
  onSaveInterval: (interval: { start: string; end: string }) => void;
}) {
  const stored = (row?.intervals as { start: string; end: string }[] | null)?.[0];
  const [draft, setDraft] = useState(stored ?? DEFAULT_HOURS_INTERVAL);

  useEffect(() => {
    setDraft(stored ?? DEFAULT_HOURS_INTERVAL);
    // stored is a new object literal every render (derived from
    // row?.intervals?.[0]) — depending on its primitive fields instead of
    // the object itself is intentional, not a missed dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored?.start, stored?.end]);

  function commit() {
    if (stored && draft.start === stored.start && draft.end === stored.end) return;
    onSaveInterval(draft);
  }

  function handleGroupBlur(e: React.FocusEvent<HTMLDivElement>) {
    // Tabbing from the start input to the end input (or back) moves focus
    // to a sibling inside this same group — not a real "done editing" —
    // so only commit once focus actually leaves the pair.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    commit();
  }

  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <span className="w-28 text-sm font-medium">{day}</span>
      <Switch checked={!row?.is_closed} onCheckedChange={onToggle} />
      {row?.is_closed ? (
        <span className="text-xs text-muted-foreground">Closed</span>
      ) : (
        <div className="flex items-center gap-2" onBlur={handleGroupBlur}>
          <Input
            type="time"
            className="h-8 w-[120px]"
            value={draft.start}
            onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
          />
          <Input
            type="time"
            className="h-8 w-[120px]"
            value={draft.end}
            onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))}
          />
        </div>
      )}
    </li>
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

function ListEditor({
  title,
  description,
  fields,
  rows,
  onAdd,
  onRemove,
}: {
  title: string;
  description: string;
  fields: { key: string; label: string; placeholder?: string; numeric?: boolean }[];
  rows: { id: string; primary: string; secondary?: string }[];
  onAdd: (values: Record<string, string>) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <SectionCard title={title} description={description}>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">{row.primary}</p>
              {row.secondary ? <p className="text-xs text-muted-foreground">{row.secondary}</p> : null}
            </div>
            <button onClick={() => onRemove(row.id)} aria-label="Delete" className="text-muted-foreground hover:text-destructive">
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
        {!rows.length ? <li className="py-4 text-sm text-muted-foreground">Nothing added yet.</li> : null}
      </ul>

      <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{f.label}</Label>
            <Input
              value={values[f.key] ?? ""}
              placeholder={f.placeholder}
              inputMode={f.numeric ? "decimal" : undefined}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </div>
        ))}
        <div className="flex items-end">
          <Button
            size="sm"
            onClick={async () => {
              if (!fields.every((f) => f.numeric || values[f.key]?.trim())) {
                toast.error("Fill in the required fields first.");
                return;
              }
              await onAdd(values);
              setValues({});
            }}
          >
            <Plus className="mr-1.5 size-3.5" /> Add
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
