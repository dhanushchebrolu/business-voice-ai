import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useDashboardAccess } from "@/components/app/PublicNav";
import { Button } from "@/components/ui/button";

/**
 * Dark landing-page navigation. Auth-awareness is delegated entirely to
 * useDashboardAccess (PublicNav.tsx) — the exact same backend-authoritative
 * rule /app itself enforces — so this never re-derives entitlement logic;
 * it only re-styles the same three states (signed out / signed in without
 * dashboard access / signed in with dashboard access) for a dark hero.
 *
 * Every nav link resolves to a real destination: Product/Solutions/
 * Developers all smooth-scroll to real sections that exist further down
 * this same page (no invented /product, /solutions, /developers routes —
 * this app has none), Resources goes to the real /contact route, Login/
 * Get Started go to the real /auth route.
 */

const NAV_LINKS: { label: string; targetId: string }[] = [
  { label: "Product", targetId: "value-propositions" },
  { label: "Solutions", targetId: "white-label" },
  { label: "Developers", targetId: "integrations" },
];

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function LandingNav() {
  const { session, user, signOut } = useAuth();
  const { loading, hasDashboard } = useDashboardAccess();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileOpen]);

  const authActions =
    session && !loading ? (
      <>
        {hasDashboard ? (
          <Link to="/app">
            <Button size="sm" className="rounded-full">
              Dashboard
            </Button>
          </Link>
        ) : (
          <span className="hidden text-sm text-white/60 sm:inline">{user?.email}</span>
        )}
        <button
          type="button"
          onClick={async () => {
            await signOut();
            navigate({ to: "/" });
          }}
          className="rounded-full px-3 py-1.5 text-sm text-white/60 transition-colors hover:text-white"
        >
          Sign out
        </button>
      </>
    ) : (
      <>
        <Link
          to="/auth"
          className="rounded-full px-3 py-1.5 text-sm text-white/70 hover:text-white"
        >
          Login
        </Link>
        <Link to="/auth" search={{ mode: "signup" }}>
          <Button size="sm" className="rounded-full">
            Get Started
          </Button>
        </Link>
      </>
    );

  return (
    <header className="relative z-40">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-5 sm:px-8">
        <Link to="/" className="flex items-center gap-2">
          <span
            className="grid size-7 place-items-center rounded-full border border-white/20 text-[11px] font-semibold text-white"
            aria-hidden="true"
          >
            C
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-white">ClickAI</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <button
              key={link.targetId}
              type="button"
              onClick={() => scrollToSection(link.targetId)}
              className="rounded-full px-3 py-1.5 text-sm text-white/70 transition-colors hover:text-white"
            >
              {link.label}
            </button>
          ))}
          <Link
            to="/contact"
            className="rounded-full px-3 py-1.5 text-sm text-white/70 transition-colors hover:text-white"
          >
            Resources
          </Link>
        </nav>

        <div className="hidden items-center gap-2 md:flex">{authActions}</div>

        <button
          type="button"
          className="grid size-9 place-items-center rounded-full border border-white/15 text-white md:hidden"
          aria-expanded={mobileOpen}
          aria-controls="landing-mobile-menu"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>
      </div>

      {mobileOpen ? (
        <div
          id="landing-mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0d] px-6 py-6 md:hidden"
        >
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold tracking-tight text-white">ClickAI</span>
            <button
              type="button"
              className="grid size-9 place-items-center rounded-full border border-white/15 text-white"
              aria-label="Close menu"
              onClick={() => setMobileOpen(false)}
            >
              <X className="size-4" />
            </button>
          </div>
          <nav className="mt-10 flex flex-col gap-1" aria-label="Primary">
            {NAV_LINKS.map((link) => (
              <button
                key={link.targetId}
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  scrollToSection(link.targetId);
                }}
                className="rounded-lg px-3 py-3 text-left text-lg text-white/85 hover:bg-white/5"
              >
                {link.label}
              </button>
            ))}
            <Link
              to="/contact"
              onClick={() => setMobileOpen(false)}
              className="rounded-lg px-3 py-3 text-lg text-white/85 hover:bg-white/5"
            >
              Resources
            </Link>
          </nav>
          <div className="mt-auto flex flex-col gap-3 pt-8">
            {session && !loading ? (
              <>
                {hasDashboard ? (
                  <Link to="/app" onClick={() => setMobileOpen(false)}>
                    <Button className="w-full rounded-full" size="lg">
                      Dashboard
                    </Button>
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={async () => {
                    setMobileOpen(false);
                    await signOut();
                    navigate({ to: "/" });
                  }}
                  className="rounded-full border border-white/15 px-4 py-3 text-center text-white/80"
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link to="/auth" onClick={() => setMobileOpen(false)}>
                  <Button variant="outline" className="w-full rounded-full" size="lg">
                    Login
                  </Button>
                </Link>
                <Link to="/auth" search={{ mode: "signup" }} onClick={() => setMobileOpen(false)}>
                  <Button className="w-full rounded-full" size="lg">
                    Get Started
                  </Button>
                </Link>
              </>
            )}
          </div>
        </div>
      ) : null}
    </header>
  );
}
