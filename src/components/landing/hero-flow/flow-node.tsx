import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A glass card for one stop in the hero flow diagram (the AI Employee
 * source, a channel, or the Customers & Leads destination). `breathing`
 * adds a soft pulsing glow behind the card (CSS-only, respects
 * prefers-reduced-motion via the `.hero-flow-breathe` utility itself, but
 * callers still pass `reduced` so the glow element isn't mounted at all
 * for a reduced-motion visitor).
 */
export interface FlowNodeProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  size?: "primary" | "compact";
  breathing?: boolean;
  reduced?: boolean;
  className?: string;
}

export function FlowNode({
  icon: Icon,
  title,
  subtitle,
  size = "compact",
  breathing = false,
  reduced = false,
  className,
}: FlowNodeProps) {
  const isPrimary = size === "primary";
  return (
    <div className={cn("relative", className)}>
      {breathing && !reduced && (
        <span
          aria-hidden="true"
          className="hero-flow-breathe absolute -inset-4 rounded-full bg-violet-400/30 blur-xl"
        />
      )}
      <div
        className={cn(
          "relative flex items-center gap-2 rounded-2xl border border-violet-100 bg-white/95 shadow-[0_8px_24px_-12px_rgba(124,58,237,0.35)] backdrop-blur-sm",
          isPrimary
            ? "flex-col px-5 py-4 text-center sm:px-6 sm:py-5"
            : "px-2.5 py-2 sm:px-3 sm:py-2.5",
        )}
      >
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 via-indigo-500 to-cyan-400 text-white shadow-[0_4px_14px_-4px_rgba(99,102,241,0.6)]",
            isPrimary ? "size-11" : "size-7 sm:size-8",
          )}
        >
          <Icon className={isPrimary ? "size-5" : "size-3.5 sm:size-4"} />
        </span>
        <div className={isPrimary ? "" : "min-w-0"}>
          <p
            className={cn(
              "font-semibold text-slate-900",
              isPrimary ? "text-sm sm:text-base" : "truncate text-[10px] sm:text-xs",
            )}
          >
            {title}
          </p>
          {subtitle && (
            <p
              className={cn(
                "text-slate-500",
                isPrimary ? "mt-0.5 text-xs" : "hidden text-[10px] sm:block",
              )}
            >
              {subtitle}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
