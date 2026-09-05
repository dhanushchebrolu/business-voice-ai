import { Link } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "./primitives";

/**
 * Status banner shown to a signed-in user who has an account but no
 * organization has been provisioned for them. This is expected and not an
 * error: workspaces are created only when a Vaani admin creates a customer
 * and sends an invitation — signing up on its own never creates one.
 *
 * This used to be a full-page takeover that blocked the entire site for
 * these users. It is now a section rendered inside the normal authenticated
 * site (/account) — the guard still exists (customer-only functionality
 * under /app still requires a real organization), it just no longer strands
 * the user on a dead end.
 */
export function NoWorkspace() {
  return (
    <SectionCard
      title="Workspace status"
      description="Your account is signed in, but no Vaani workspace has been set up for you yet."
    >
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted">
            <Building2 className="size-4 text-muted-foreground" />
          </span>
          <p className="max-w-md text-sm text-muted-foreground">
            Your workspace hasn't been provisioned yet. The Vaani team sets this up once onboarding
            begins — until then you can still manage your profile and settings here.
          </p>
        </div>
        <Link to="/contact">
          <Button size="sm" variant="secondary">
            Talk to the Vaani team
          </Button>
        </Link>
      </div>
    </SectionCard>
  );
}
