import { Lock } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "./primitives";
import { Button } from "@/components/ui/button";
import { FEATURE_LABEL, type FeatureKey } from "@/lib/features";
import type { LifecycleStatus } from "@/lib/lifecycle";
import { lockMessageFor } from "@/lib/service-lock-message";

/**
 * Customer-facing "this service isn't available right now" UI (H2).
 *
 * Reuses the same feature-lock data every page already fetches via
 * featureLocksQuery (src/lib/access.ts, itself backed by the canonical
 * feature_locked() resolver) and the same lifecycle info app.tsx/
 * AccountLocked already read from the workspace query. This component only
 * *presents* that state — it never decides it. Server-side authorization
 * (feature_locked() itself, and the H1 assertFeatureUnlocked checks in
 * agent.functions.ts / checkTelephonyAccess in telephony-guard.server.ts)
 * remains the sole authority: hiding or disabling a button here is a UX
 * courtesy, not a security boundary. If a request reached the server
 * despite what this component shows, H1/telephony authorization still
 * rejects it exactly as before this file existed.
 *
 * Message wording itself lives in src/lib/service-lock-message.ts (kept
 * out of this JSX file purely so it's directly unit-testable — see that
 * file's doc comment).
 */

export interface ServiceLockedProps {
  feature: FeatureKey;
  lifecycle: LifecycleStatus;
  /**
   * Compact renders a small inline banner meant to sit alongside content
   * that should stay usable (e.g. agent configuration while only
   * publishing is locked). Non-compact renders a full EmptyState block
   * meant to replace an entire interactive/billable panel.
   */
  compact?: boolean;
}

export function ServiceLocked({ feature, lifecycle, compact = false }: ServiceLockedProps) {
  const label = FEATURE_LABEL[feature] ?? feature;
  const { title, description, cta } = lockMessageFor(lifecycle, label);
  const action = cta ? (
    <Button asChild size="sm" variant="outline">
      <Link to={cta.to}>{cta.label}</Link>
    </Button>
  ) : undefined;

  if (compact) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border-strong bg-surface/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2.5">
          <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {action}
      </div>
    );
  }

  return <EmptyState icon={Lock} title={title} description={description} action={action} />;
}
