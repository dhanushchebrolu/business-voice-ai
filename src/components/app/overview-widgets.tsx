import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { DayBucket, WeekBucket } from "@/lib/overview-metrics";
import { StatusPill } from "./primitives";

type Icon = React.ComponentType<{ className?: string }>;
type Tone = "live" | "ready" | "idle" | "error" | "info" | "accent";

/** One customer channel (phone, voice agent, WhatsApp, website chatbot) with its real status and a way to manage it. */
export function ServiceCard({
  icon: Icon,
  label,
  tone,
  statusLabel,
  hint,
  to,
  actionLabel,
}: {
  icon: Icon;
  label: string;
  tone: Tone;
  statusLabel: string;
  hint: string;
  to?: string;
  actionLabel?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            "grid size-10 place-items-center rounded-xl",
            tone === "live" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-5" />
        </span>
        <StatusPill tone={tone}>{statusLabel}</StatusPill>
      </div>
      <p className="mt-4 text-sm font-semibold">{label}</p>
      <p className="mt-0.5 min-h-8 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      {to ? (
        <p className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary transition-[gap] group-hover:gap-1.5">
          {actionLabel ?? "Manage"} <ArrowUpRight className="size-3.5" />
        </p>
      ) : null}
    </>
  );
  const cls = "panel group block p-5 transition-shadow";
  return to ? (
    <Link to={to} className={cn(cls, "hover:shadow-[0_12px_32px_-16px_oklch(0.55_0.23_262/0.35)]")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function ChartShell({ children, summary }: { children: ReactNode; summary: string }) {
  return (
    <div role="img" aria-label={summary} className="select-none">
      {children}
    </div>
  );
}

/** Stacked daily bars: answered (blue) over missed (grey). Heights are relative to the busiest day shown. */
export function CallActivityChart({ days }: { days: DayBucket[] }) {
  const max = Math.max(1, ...days.map((d) => d.answered + d.missed));
  const total = days.reduce((n, d) => n + d.answered + d.missed, 0);
  const summary = `Calls per day over the last ${days.length} days: ${total} in total, ${days.reduce((n, d) => n + d.answered, 0)} answered and ${days.reduce((n, d) => n + d.missed, 0)} missed.`;
  return (
    <ChartShell summary={summary}>
      <div className="flex h-44 items-end gap-1.5 border-b border-border">
        {days.map((d) => {
          const n = d.answered + d.missed;
          return (
            <div
              key={d.key}
              className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${d.label}: ${d.answered} answered, ${d.missed} missed`}
            >
              <div
                className="flex w-full flex-col justify-end overflow-hidden rounded-t-md"
                style={{ height: `${(n / max) * 100}%` }}
              >
                <div className="bg-muted-foreground/25" style={{ flexGrow: d.missed }} />
                <div className="bg-primary" style={{ flexGrow: d.answered }} />
              </div>
              {n === 0 ? <div className="h-px w-full bg-border-strong" /> : null}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{days[0]?.label}</span>
        <span>{days[Math.floor(days.length / 2)]?.label}</span>
        <span>{days[days.length - 1]?.label}</span>
      </div>
      <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary" /> Answered
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-muted-foreground/25" /> Missed
        </span>
      </div>
    </ChartShell>
  );
}

/** Weekly counts as violet bars (used for captured contacts). */
export function WeeklyBars({ weeks, noun }: { weeks: WeekBucket[]; noun: string }) {
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const total = weeks.reduce((n, w) => n + w.count, 0);
  return (
    <ChartShell summary={`${total} ${noun} over the last ${weeks.length} weeks.`}>
      <div className="flex h-28 items-end gap-2 border-b border-border">
        {weeks.map((w) => (
          <div
            key={w.key}
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            title={`Week of ${w.label}: ${w.count}`}
          >
            <div
              className="w-full rounded-t-md bg-chart-2"
              style={{ height: w.count ? `${Math.max(6, (w.count / max) * 100)}%` : "0%" }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{weeks[0]?.label}</span>
        <span>{weeks[weeks.length - 1]?.label}</span>
      </div>
    </ChartShell>
  );
}

/** A labelled horizontal bar split into parts; used for answered/missed and for the language mix. */
export function SplitBar({
  parts,
}: {
  parts: { label: string; value: number; className: string }[];
}) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return <p className="text-sm text-muted-foreground">No data yet.</p>;
  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}
      >
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div
              key={p.label}
              className={p.className}
              style={{ width: `${(p.value / total) * 100}%` }}
            />
          ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-xs">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className={cn("size-2.5 rounded-sm", p.className)} />
              {p.label}
            </span>
            <span className="font-medium tabular">
              {p.value}{" "}
              <span className="text-muted-foreground">
                ({Math.round((p.value / total) * 100)}%)
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
