import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, LogOut, ShieldCheck } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { profileQuery } from "@/lib/profile";
import { workspaceQuery } from "@/lib/workspace";
import { PageHeader, SectionCard, StatusPill, LoadingState } from "@/components/app/primitives";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/account/")({
  component: AccountOverview,
});

function AccountOverview() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { data: profile, isLoading } = useQuery(profileQuery(user?.id));
  const { data: ws } = useQuery(workspaceQuery(user?.id));

  if (isLoading) return <LoadingState label="Loading your account" />;

  const org = ws?.organization;
  const emailVerified = Boolean(user?.email_confirmed_at ?? user?.confirmed_at);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome${profile?.full_name ? `, ${profile.full_name}` : ""}`}
        description="Your Vaani account — profile, workspace status and access."
      />

      {org && org.lifecycle_status !== "archived" ? (
        <SectionCard title="Workspace" description="Your workspace is provisioned and ready.">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{org.name}</p>
            <Link to="/app">
              <Button size="sm">
                Go to dashboard <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            </Link>
          </div>
        </SectionCard>
      ) : (
        <NoWorkspace />
      )}

      <SectionCard title="Profile" description="Basic information tied to your account.">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Name
            </dt>
            <dd className="mt-1 text-sm font-medium">{profile?.full_name ?? "Not set"}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Email
            </dt>
            <dd className="mt-1 flex items-center gap-1.5 text-sm font-medium">
              {user?.email}
              {emailVerified ? (
                <StatusPill tone="live" dot={false}>
                  <ShieldCheck className="mr-1 size-3" /> Verified
                </StatusPill>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Phone
            </dt>
            <dd className="mt-1 text-sm font-medium">{profile?.phone ?? "Not set"}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Account status
            </dt>
            <dd className="mt-1 text-sm font-medium">
              {org ? "Workspace active" : "Signed in — no workspace yet"}
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title="Security" description="Manage your password from Settings.">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link to="/account/settings" search={{ tab: "security" }}>
            <Button size="sm" variant="outline">
              Change password
            </Button>
          </Link>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await signOut();
              navigate({ to: "/auth" });
            }}
          >
            <LogOut className="mr-1.5 size-3.5" /> Sign out
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
