import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronDown, Menu, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useDashboardAccess } from "@/components/app/PublicNav";
import { Button } from "@/components/ui/button";

/**
 * Dark landing-page navigation, matching the reference's exact shape: logo
 * left, a row of plain nav links centered on desktop, and a single menu
 * control on the right (no inline auth buttons in the bar itself — those
 * live inside the menu overlay, which doubles as the mobile nav).
 *
 * Auth-awareness is delegated entirely to useDashboardAccess (PublicNav.tsx)
 * — the exact same backend-authoritative rule /app itself enforces — so
 * this never re-derives entitlement logic.
 *
 * Every nav link resolves to a real destination: Product/Solutions/
 * Developers all smooth-scroll to real sections that exist further down
 * this same page (no invented /product, /solutions, /developers routes —
 * this app has none), Resources goes to the real /contact route, Login/
 * Get Started go to the real /auth route.
 */

const NAV_LINKS: { label: string; targetId: string; hasChevron?: boolean }[] = [
  { label: "Product", targetId: "value-propositions", hasChevron: true },
  { label: "Solutions", targetId: "feature-showcase" },
  { label: "Developers", targetId: "integrations" },
];

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function LandingNav() {
  const { session, user, signOut } = useAuth();
  const { loading, hasDashboard } = useDashboardAccess();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <header className="relative z-40">
      <div className="mx-auto flex h-20 max-w-[1400px] items-center justify-between px-5 sm:px-8">
        <Link to="/" className="flex items-center gap-2">
          <span
            className="grid size-7 place-items-center rounded-full border border-white/20 text-[11px] font-semibold text-white"
            aria-hidden="true"
          >
            C
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-white">ClickAI</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <button
              key={link.targetId}
              type="button"
              onClick={() => scrollToSection(link.targetId)}
              className="inline-flex items-center gap-1 text-sm text-white/70 transition-colors hover:text-white"
            >
              {link.label}
              {link.hasChevron ? <ChevronDown className="size-3.5" /> : null}
            </button>
          ))}
          <Link to="/contact" className="text-sm text-white/70 transition-colors hover:text-white">
            Resources
          </Link>
        </nav>

        <button
          type="button"
          className="grid size-10 place-items-center rounded-full border border-white/15 text-white"
          aria-expanded={menuOpen}
          aria-controls="landing-menu"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>
      </div>

      {menuOpen ? (
        <div
          id="landing-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0d] px-6 py-6"
        >
          <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between">
            <span className="text-[15px] font-semibold tracking-tight text-white">ClickAI</span>
            <button
              type="button"
              className="grid size-9 place-items-center rounded-full border border-white/15 text-white"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col justify-center gap-10 sm:flex-row sm:items-center sm:justify-between">
            <nav className="flex flex-col gap-1" aria-label="Primary">
              {NAV_LINKS.map((link) => (
                <button
                  key={link.targetId}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    scrollToSection(link.targetId);
                  }}
                  className="rounded-lg px-2 py-3 text-left font-serif text-3xl text-white/85 hover:text-white sm:text-4xl"
                >
                  {link.label}
                </button>
              ))}
              <Link
                to="/contact"
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-2 py-3 font-serif text-3xl text-white/85 hover:text-white sm:text-4xl"
              >
                Resources
              </Link>
            </nav>

            <div className="flex flex-col gap-3 sm:w-64">
              {session && !loading ? (
                <>
                  {hasDashboard ? (
                    <Link to="/app" onClick={() => setMenuOpen(false)}>
                      <Button className="w-full rounded-full" size="lg">
                        Dashboard
                      </Button>
                    </Link>
                  ) : (
                    <span className="text-sm text-white/60">{user?.email}</span>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      setMenuOpen(false);
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
                  <Link to="/auth" onClick={() => setMenuOpen(false)}>
                    <Button variant="outline" className="w-full rounded-full" size="lg">
                      Login
                    </Button>
                  </Link>
                  <Link to="/auth" search={{ mode: "signup" }} onClick={() => setMenuOpen(false)}>
                    <Button className="w-full rounded-full" size="lg">
                      Get Started
                    </Button>
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
