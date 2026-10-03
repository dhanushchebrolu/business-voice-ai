import { cn } from "@/lib/utils";

/**
 * A small conversational snippet that fades in/out near the flow diagram
 * (never a full transcript, never claiming to be a live conversation —
 * purely decorative, aria-hidden). `.hero-flow-bubble` loops the fade via
 * CSS so it respects prefers-reduced-motion on its own; the component
 * doesn't render at all when `reduced` is true, leaving the diagram's
 * static structure uncluttered per the brief's reduced-motion requirement.
 */
export interface MessageBubbleProps {
  text: string;
  reduced: boolean;
  delay?: number;
  duration?: number;
  className?: string;
}

export function MessageBubble({
  text,
  reduced,
  delay = 0,
  duration = 9,
  className,
}: MessageBubbleProps) {
  if (reduced) return null;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "hero-flow-bubble pointer-events-none absolute max-w-[170px] rounded-xl border border-violet-100 bg-white/95 px-3 py-2 text-[11px] leading-snug text-slate-600 opacity-0 shadow-[0_10px_24px_-12px_rgba(99,102,241,0.45)]",
        className,
      )}
      style={{ animationDuration: `${duration}s`, animationDelay: `${delay}s` }}
    >
      {text}
    </div>
  );
}
