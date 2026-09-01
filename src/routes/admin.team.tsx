import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { listPlatformAdmins, upsertPlatformAdmin } from "@/lib/admin.functions";
import { PageHeader, SectionCard, LoadingState, ErrorState, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import type { Database } from "@/integrations/supabase/types";

type PlatformRole = Database["public"]["Enums"]["platform_role"];
const ROLES: PlatformRole[] = ["super_admin", "admin", "finance", "support", "operations"];

export const Route = createFileRoute("/admin/team")({
  component: AdminTeam,
});

function AdminTeam() {
  const fetchAdmins = useServerFn(listPlatformAdmins);
  const saveAdmin = useServerFn(upsertPlatformAdmin);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PlatformRole>("support");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-team"],
    queryFn: () => fetchAdmins(),
  });

  if (isLoading) return <LoadingState label="Loading admin team" />;
  if (error) return <ErrorState message={error instanceof Error ? error.message : "Could not load the team"} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin team"
        description="Platform administrators only. A customer's organization role never grants access to this area."
        actions={<Button onClick={() => setOpen(true)}>Grant access</Button>}
      />

      <SectionCard title="Administrators" description="Role decides which privileged actions the server will accept.">
        <ul className="divide-y divide-border">
          {(data ?? []).map((a) => (
            <li key={a.user_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">{a.name ?? a.email ?? a.user_id}</p>
                <p className="text-xs text-muted-foreground">{a.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill tone={a.is_active ? "live" : "idle"}>{a.is_active ? "Active" : "Revoked"}</StatusPill>
                <StatusPill tone="accent">{a.role.replace("_", " ")}</StatusPill>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>

      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title="Grant platform admin access"
        description="The person must already have a Vaani account. Access is verified server-side on every request."
        confirmLabel="Grant access"
        extra={
          <div className="space-y-2">
            <Input placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} />
            <div className="flex flex-wrap gap-1.5">
              {ROLES.map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className={`rounded-full border px-3 py-1 text-xs capitalize ${
                    role === r ? "border-primary/40 bg-primary/12 text-primary" : "border-border text-muted-foreground"
                  }`}
                >
                  {r.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>
        }
        onConfirm={async (reason) => {
          await saveAdmin({ data: { email, role, isActive: true, reason } });
          toast.success("Platform admin updated");
          setEmail("");
          await queryClient.invalidateQueries({ queryKey: ["admin-team"] });
        }}
      />
    </div>
  );
}
