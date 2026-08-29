import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { workspaceQuery, servicesQuery, faqsQuery, rulesQuery, hoursQuery } from "@/lib/workspace";
import { getBusinessType, DAYS } from "@/lib/business-types";
import { PageHeader, SectionCard, LoadingState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/app/business")({
  head: () => ({
    meta: [
      { title: "Business profile — Vaani" },
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
                const interval = (row?.intervals as { from: string; to: string }[] | null)?.[0];
                return (
                  <li key={day} className="flex flex-wrap items-center gap-3 py-2.5">
                    <span className="w-28 text-sm font-medium">{day}</span>
                    <Switch
                      checked={!row?.is_closed}
                      onCheckedChange={async (open) => {
                        if (!row) return;
                        await supabase
                          .from("business_hours")
                          .update({ is_closed: !open, intervals: open ? [interval ?? { from: "09:00", to: "19:00" }] : [] })
                          .eq("id", row.id);
                        refresh();
                      }}
                    />
                    {row?.is_closed ? (
                      <span className="text-xs text-muted-foreground">Closed</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        {(["from", "to"] as const).map((key) => (
                          <Input
                            key={key}
                            type="time"
                            className="h-8 w-[120px]"
                            value={interval?.[key] ?? (key === "from" ? "09:00" : "19:00")}
                            onChange={async (e) => {
                              if (!row) return;
                              const base = interval ?? { from: "09:00", to: "19:00" };
                              await supabase
                                .from("business_hours")
                                .update({ intervals: [{ ...base, [key]: e.target.value }] })
                                .eq("id", row.id);
                              refresh();
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </li>
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
