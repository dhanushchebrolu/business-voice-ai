import { useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "./primitives";
import { Button } from "@/components/ui/button";

/**
 * Shown when a signed-in user has an account but no organization has been
 * provisioned for them. This is expected and not an error: workspaces are
 * created only when a Vaani admin creates a customer and sends an
 * invitation (Phase B §1/§2) — signing up on its own never creates one.
 */
export function NoWorkspace() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-4 lg:px-8">
        <Logo />
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">{user?.email}</span>
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
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-4 py-12 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">No workspace yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account is signed in, but no Vaani workspace has been set up for you yet. If you're
          expecting access, reach out to your Vaani contact — workspaces are created by our team
          once onboarding begins.
        </p>
        <Button className="mt-6" variant="outline" onClick={() => navigate({ to: "/" })}>
          Back to vaani.ai
        </Button>
      </main>
    </div>
  );
}
