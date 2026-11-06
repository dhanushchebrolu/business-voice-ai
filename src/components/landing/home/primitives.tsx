import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Building blocks for the homepage. Motion rules: transform/opacity/colour only,
 * one shared scroll listener, everything visible without JS and under
 * prefers-reduced-motion.
 */

/* ───── one shared, rAF-throttled scroll/resize subscription ───── */

const subscribers = new Set<() => void>();
let queued = false;
let attached = false;

function flush() {
  queued = false;
  subscribers.forEach((fn) => fn());
}
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(flush);
}
export function subscribeScroll(fn: () => void) {
  if (!attached) {
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    attached = true;
  }
  subscribers.add(fn);
  fn();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && attached) {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      attached = false;
    }
  };
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ───── in-view flag (visible on the server; hidden only after mount if below the fold) ───── */

export function useEnter<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.95) return;
    setShown(false);
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, shown] as const;
}

/* ───── scroll-linked word fill (headings) ───── */

/**
 * Words go from the faint grey to ink as the heading scrolls through the
 * viewport (start: top at 88% of the viewport height, end: top at 38%).
 * Progress is written to a CSS variable, so there is no React work per frame.
 * The reference's exact range/easing is not available from its page; these
 * values were chosen to match the recording.
 */
export function ScrollFill({
  text,
  className,
  as: Tag = "h2",
}: {
  text: string;
  className?: string;
  as?: "h1" | "h2";
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const words = text.split(" ");
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    return subscribeScroll(() => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = (vh * 0.88 - r.top) / (vh * 0.5);
      el.style.setProperty("--p", String(Math.min(1, Math.max(0, p))));
    });
  }, []);
  return (
    <Tag
      ref={ref}
      aria-label={text}
      style={{ "--p": 1, "--n": words.length } as CSSProperties}
      className={cn("font-display tracking-[-0.02em]", className)}
    >
      {words.map((w, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={
            {
              "--i": i,
              color:
                "color-mix(in srgb, var(--vx-ink) calc(100% * clamp(0, var(--p) * var(--n) - var(--i), 1)), var(--vx-faint))",
            } as CSSProperties
          }
        >
          {w}{" "}
        </span>
      ))}
    </Tag>
  );
}

/* ───── digit-roll counter ───── */

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export function RollNumber({ value, className }: { value: string; className?: string }) {
  const [ref, shown] = useEnter<HTMLSpanElement>();
  return (
    <span
      ref={ref}
      className={cn("inline-flex tabular-nums leading-none", className)}
      aria-label={value}
    >
      {value.split("").map((ch, i) => {
        if (!/\d/.test(ch)) {
          return (
            <span key={i} aria-hidden="true">
              {ch === " " ? " " : ch}
            </span>
          );
        }
        const d = Number(ch);
        return (
          <span
            key={i}
            aria-hidden="true"
            className="inline-block h-[1em] overflow-hidden"
            style={{ lineHeight: 1 }}
          >
            <span
              className="flex flex-col transition-transform duration-[1100ms] motion-reduce:transition-none"
              style={{
                transform: `translateY(${shown ? -d : 0}em)`,
                transitionTimingFunction: "var(--vx-ease)",
                transitionDelay: `${i * 70}ms`,
              }}
            >
              {DIGITS.map((n) => (
                <span key={n} className="block h-[1em]" style={{ lineHeight: 1 }}>
                  {n}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/* ───── marquee ───── */

export function Marquee({
  children,
  seconds = 40,
  className,
  label,
}: {
  children: ReactNode;
  seconds?: number;
  className?: string;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_8%,#000_92%,transparent)]",
        className,
      )}
    >
      <div
        className="vx-marquee-track flex w-max"
        style={{ "--vx-dur": `${seconds}s` } as CSSProperties}
      >
        <div className="flex shrink-0 items-center">{children}</div>
        <div className="flex shrink-0 items-center" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ───── entrance with stagger (reference: staggered fade-up) ───── */

export function Enter({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const [ref, shown] = useEnter<HTMLDivElement>();
  return (
    <div
      ref={ref}
      style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
      className={cn(
        "transition-[opacity,transform] duration-700 ease-out motion-reduce:transition-none",
        !shown && "translate-y-4 opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ───── buttons (mono caps, square) ───── */

const BTN =
  "inline-flex h-11 items-center gap-2 px-5 font-vmono text-[13px] font-medium uppercase tracking-[0.08em] transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)]";

export function VxLink({
  to,
  href,
  hash,
  search,
  variant = "solid",
  children,
  className,
}: {
  /** A route of this app. */
  to?: string;
  /** Or an on-page anchor such as "#contact" (plain link, no router navigation). */
  href?: string;
  hash?: string;
  search?: Record<string, string>;
  variant?: "solid" | "outline" | "text" | "outline-dark";
  children: ReactNode;
  className?: string;
}) {
  const styles = {
    solid: "bg-[var(--vx-btn)] text-white hover:bg-[var(--vx-accent-hot)]",
    outline:
      "border border-[var(--vx-ink)] text-[var(--vx-ink)] hover:bg-[var(--vx-ink)] hover:text-[var(--vx-page)]",
    "outline-dark": "border border-white/40 text-white hover:bg-white hover:text-[var(--vx-dark)]",
    text: "px-0 text-[var(--vx-ink)] hover:text-[var(--vx-accent-hot)]",
  }[variant];
  if (href !== undefined) {
    return (
      <a href={href} className={cn(BTN, styles, className)}>
        {children}
      </a>
    );
  }
  return (
    // `to` is always one of this app's real routes (checked by the route tree at the call sites).
    <Link
      to={(to ?? "/") as "/"}
      {...(hash ? { hash } : {})}
      {...(search ? { search: search as never } : {})}
      className={cn(BTN, styles, className)}
    >
      {children}
    </Link>
  );
}

/* ───── section shell with index label and dot field ───── */

export function VxSection({
  id,
  index,
  label,
  bg = "page",
  dark = false,
  children,
  className,
}: {
  id?: string;
  index?: string;
  label?: string;
  bg?: "page" | "alt" | "dark" | "accent";
  dark?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const bgClass = {
    page: "bg-[var(--vx-page)]",
    alt: "bg-[var(--vx-alt)]",
    dark: "bg-[var(--vx-dark)] text-white",
    accent: "bg-[linear-gradient(120deg,var(--vx-accent)_0%,var(--vx-violet)_100%)] text-white",
  }[bg];
  return (
    <section id={id} className={cn("relative isolate overflow-clip", bgClass, className)}>
      {bg !== "accent" ? (
        <div
          aria-hidden="true"
          className={cn(
            "vx-dots absolute inset-0 -z-10",
            (dark || bg === "dark") && "vx-dots-dark",
          )}
        />
      ) : null}
      <div className="mx-auto max-w-[1305px] px-5 py-20 sm:px-10 sm:py-28 lg:px-[39px]">
        {index ? (
          <p className="mb-6 flex items-center gap-4 font-vmono text-[11px] font-medium uppercase tracking-[0.14em]">
            <span
              className={cn(
                "text-sm font-semibold tracking-[0.08em]",
                bg === "accent" ? "text-white" : "text-[var(--vx-accent-deep)]",
                bg === "dark" && "text-[var(--vx-accent-hot)]",
              )}
            >
              {index}
            </span>
            <span
              className={bg === "dark" || bg === "accent" ? "text-white" : "text-[var(--vx-muted)]"}
            >
              {label}
            </span>
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export const MONO_P = "font-vmono text-[14px] leading-[1.7] text-[var(--vx-muted)]";
export const H2 = "text-[28px] leading-[1.2] sm:text-[40px]";
