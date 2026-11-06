import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";
import { Logo } from "@/components/app/primitives";
import { useDashboardAccess } from "@/components/app/PublicNav";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import { VxLink } from "./primitives";
import { toggleTheme, useVxTheme } from "./theme";

/**
 * Homepage header: one static bar (no entrance, slide or scroll-swap animation).
 * Home · Products ▾ · Solutions · How It Works · Pricing · Contact, theme toggle,
 * sign-in and a Book a Demo button. Below `lg` the links move into a plain
 * full-screen panel. Auth-awareness uses the same hooks as the shared nav.
 */

/** Marketing links: every one scrolls to a section of this page. Sign in is the only route change. */
const SECTION_LINKS = [
  ["Home", "#home"],
  ["Products", "#products"],
  ["Solutions", "#solutions"],
  ["How It Works", "#how-it-works"],
  ["Pricing", "#pricing"],
  ["Contact", "#contact"],
] as const;

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--vx-accent)]";
const LINK = cn(
  "inline-flex h-10 items-center font-vmono text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--vx-ink)] transition-colors hover:text-[var(--vx-accent-hot)]",
  FOCUS,
);

function ThemeToggle() {
  const theme = useVxTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={(e) => toggleTheme(e.currentTarget)}
      aria-pressed={dark}
      aria-label="Dark mode"
      className={cn(
        "grid size-10 place-items-center text-[var(--vx-ink)] transition-colors hover:text-[var(--vx-accent-hot)]",
        FOCUS,
      )}
    >
      <span className="relative grid size-[18px] place-items-center">
        <Sun
          className={cn(
            "vx-theme-icon absolute size-[18px] transition-[transform,opacity] duration-300 motion-reduce:transition-none",
            dark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0",
          )}
          aria-hidden="true"
        />
        <Moon
          className={cn(
            "vx-theme-icon absolute size-[18px] transition-[transform,opacity] duration-300 motion-reduce:transition-none",
            dark ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100",
          )}
          aria-hidden="true"
        />
      </span>
    </button>
  );
}

export function VxNav() {
  const { session, signOut } = useAuth();
  const { loading, hasDashboard } = useDashboardAccess();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    const btn = menuBtn.current;
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      btn?.focus();
    };
  }, [open]);

  const signedIn = !!session && !loading;
  const authLink = signedIn ? (
    hasDashboard ? (
      <Link to="/app" className={LINK}>
        Dashboard
      </Link>
    ) : null
  ) : (
    <Link to="/auth" className={LINK}>
      Sign in
    </Link>
  );

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 border-b border-[var(--vx-hair)] bg-[var(--vx-page)]">
        <div className="mx-auto flex h-16 max-w-[1305px] items-center justify-between gap-4 px-5 sm:px-10 lg:px-[39px]">
          <a href="#home" aria-label="ClickAI home" className={FOCUS}>
            <Logo />
          </a>
          <nav aria-label="Primary" className="hidden items-center gap-7 lg:flex">
            {SECTION_LINKS.map(([label, href]) => (
              <a key={href} href={href} className={LINK}>
                {label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-1 sm:gap-3">
            <ThemeToggle />
            <span className="hidden lg:block">{authLink}</span>
            <VxLink href="#contact" className="hidden sm:inline-flex">
              Book a Demo
            </VxLink>
            <button
              type="button"
              ref={menuBtn}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label="Open menu"
              onClick={() => setOpen(true)}
              className={cn(
                "grid size-10 place-items-center text-[var(--vx-ink)] lg:hidden",
                FOCUS,
              )}
            >
              <Menu className="size-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="fixed inset-0 z-50 overflow-y-auto bg-[var(--vx-page)] text-[var(--vx-ink)]"
        >
          <div className="mx-auto flex h-16 max-w-[1305px] items-center justify-between px-5 sm:px-10">
            <Logo />
            <button
              type="button"
              ref={closeBtn}
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className={cn("grid size-10 place-items-center", FOCUS)}
            >
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          <nav aria-label="Mobile" className="mx-auto max-w-[1305px] px-5 pb-10 sm:px-10">
            <ul>
              {SECTION_LINKS.map(([label, href]) => (
                <li key={href} className="border-t border-[var(--vx-hair)]">
                  <a
                    href={href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-14 items-center font-display text-2xl tracking-[-0.02em]"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-3 border-t border-[var(--vx-hair)] pt-6">
              <VxLink href="#contact">Book a Demo</VxLink>
              {signedIn ? (
                <>
                  {hasDashboard ? (
                    <VxLink to="/app" variant="outline">
                      Dashboard
                    </VxLink>
                  ) : null}
                  <button
                    type="button"
                    onClick={async () => {
                      setOpen(false);
                      await signOut();
                      navigate({ to: "/" });
                    }}
                    className="inline-flex h-11 items-center border border-[var(--vx-hair)] px-5 font-vmono text-[13px] font-medium uppercase tracking-[0.08em]"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <VxLink to="/auth" variant="outline">
                  Sign in
                </VxLink>
              )}
            </div>
          </nav>
        </div>
      ) : null}
    </>
  );
}
