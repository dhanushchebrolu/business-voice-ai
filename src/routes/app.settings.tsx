import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { workspaceQuery } from "@/lib/workspace";
import { PageHeader, SectionCard } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/app/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Vaani" },
      { name: "description", content: "Workspace name, timezone and account settings." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { user, signOut } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (ws?.organization) {
      setName(ws.organization.name);
      setTimezone(ws.organization.timezone);
    }
  }, [ws?.organization]);

  async function save() {
    if (!ws?.organization) return;
    setSaving(true);
    const { error } = await supabase.from("organizations").update({ name, timezone }).eq("id", ws.organization.id);
    setSaving(false);
    if (error) {
      toast.error("Could not save workspace settings.");
      return;
    }
    await qc.invalidateQueries({ queryKey: ["workspace"] });
    toast.success("Workspace updated.");
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Workspace identity and account access." />

      <SectionCard
        title="Workspace"
        actions={
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}Save
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Workspace name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Timezone</Label>
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Account" description="You are signed in on this device.">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{user?.email}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await signOut();
              navigate({ to: "/auth" });
            }}
          >
            Sign out
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
