import { Check, Loader2, Circle, AlertTriangle, Hourglass } from "lucide-react";
import type { CustomerJobView } from "@/lib/voice-provisioning-job";

/** Real job steps as the backend recorded them (never an animation or a guess). */
export function ActivationProgress({ view }: { view: CustomerJobView }) {
  const icon = (status: string) => {
    if (status === "done") return <Check className="size-3.5 text-success" aria-hidden />;
    if (status === "running") return <Loader2 className="size-3.5 animate-spin" aria-hidden />;
    if (status === "failed")
      return <AlertTriangle className="size-3.5 text-destructive" aria-hidden />;
    if (status === "waiting") return <Hourglass className="size-3.5 text-warning" aria-hidden />;
    return <Circle className="size-3.5 text-muted-foreground/50" aria-hidden />;
  };
  return (
    <ol
      className="mt-3 space-y-1.5"
      aria-label="Activation progress"
      data-testid="activation-steps"
    >
      {view.steps
        .filter((s) => s.key !== "complete" || view.phase === "completed")
        .map((s) => (
          <li
            key={s.key}
            className={`flex items-center gap-2 text-xs ${
              s.status === "pending" ? "text-muted-foreground" : ""
            }`}
            data-status={s.status}
          >
            {icon(s.status)}
            <span>{s.label}</span>
          </li>
        ))}
    </ol>
  );
}
