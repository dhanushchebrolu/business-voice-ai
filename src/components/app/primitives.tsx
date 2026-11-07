import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

/**
 * The supplied logo has transparent margins around the artwork (it is 2172x724, the artwork
 * is 68% x 49% of it, centred). The box below is exactly the artwork's size and the image is
 * centred in it at a fixed scale, so the logo is never cropped, stretched or resized by
 * theme, and takes the same space as before.
 *
 * The wordmark is dark navy, so on dark surfaces there is a second file with identical
 * dimensions and a white wordmark (public/clickai-logo-transparent-dark.png): `onDark` uses it
 * always (footer), and on the homepage dark theme CSS swaps to it (styles.css). Elsewhere
 * `plate` keeps a white plate behind the original; the plate is a ring, so it never changes the box.
 */
const LOGO_IMG =
  "pointer-events-none absolute left-1/2 top-1/2 h-[64.7px] w-auto max-w-none -translate-x-1/2 -translate-y-1/2 select-none object-contain sm:h-[72.8px]";

export function Logo({
  className,
  plate = false,
  onDark = false,
}: {
  className?: string;
  plate?: boolean;
  onDark?: boolean;
}) {
  return (
    <div className={cn("flex items-center", className)}>
      <span
        className={cn(
          "clickai-logo relative block h-8 w-[132.4px] shrink-0 rounded-md sm:h-9 sm:w-[148.9px]",
          !onDark &&
            (plate
              ? "bg-white ring-[6px] ring-white"
              : "bg-white ring-[6px] ring-white [.theme-light_&]:bg-transparent [.theme-light_&]:ring-0"),
        )}
      >
        <img
          src="/clickai-logo-transparent.png"
          alt="ClickAI"
          width={2172}
          height={724}
          className={cn(LOGO_IMG, "vx-logo-light", onDark && "hidden")}
        />
        <img
          src="/clickai-logo-transparent-dark.png"
          alt="ClickAI"
          width={2172}
          height={724}
          className={cn(LOGO_IMG, "vx-logo-dark", !onDark && "hidden")}
        />
      </span>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

const toneMap = {
  live: "bg-success/12 text-success border-success/25",
  ready: "bg-warning/12 text-warning border-warning/25",
  idle: "bg-muted text-muted-foreground border-border",
  error: "bg-destructive/12 text-destructive border-destructive/25",
  info: "bg-info/12 text-info border-info/25",
  accent: "bg-primary/12 text-primary border-primary/25",
} as const;

export function StatusPill({
  tone = "idle",
  children,
  dot = true,
  className,
}: {
  tone?: keyof typeof toneMap;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        toneMap[tone],
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface/40 px-6 py-14 text-center">
      {Icon ? (
        <span className="mb-4 grid size-10 place-items-center rounded-lg border border-border bg-surface-raised">
          <Icon className="size-4 text-muted-foreground" />
        </span>
      ) : null}
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
      <div className="flex items-center justify-between gap-4">
        <span>{message}</span>
        {onRetry ? (
          <button
            onClick={onRetry}
            className="shrink-0 rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium"
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-10 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}…
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "accent";
}) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-2 text-2xl font-semibold tabular", tone === "accent" && "text-primary")}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel", className)}>
      <header className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
