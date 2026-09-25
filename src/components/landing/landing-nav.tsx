import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Menu, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useDashboardAccess } from "@/components/app/PublicNav";
import { Button } from "@/components/ui/button";
import { BUSINESS_TYPES } from "@/lib/business-types";

/**
 * Dark landing-page navigation: logo left, Products / Pricing /
 * Integrations / Industries centered (Products/Integrations/Industries
 * open a real dropdown; Pricing is a direct link to the real /pricing
 * route), a persistent Contact button, and a single menu control that
 * still owns the mobile nav + all auth-aware CTAs (Login/Get Started/
 * Dashboard/Sign out) exactly as before — auth-awareness stays entirely
 * delegated to useDashboardAccess (PublicNav.tsx), the same backend-
 * authoritative rule /app itself enforces, never re-derived here.
 *
 * Every dropdown item is a real scroll-to-section link, not a placeholder:
 * this component is only ever rendered on "/" (the landing page itself —
 * see landing-nav.test.ts), so a plain in-page scroll is always correct
 * and never needs a cross-route hash. Product items target the id each
 * product card in value-propositions.tsx now carries; Integrations and
 * Industries items all target their own real section further down this
 * same page (#integrations / #industries).
 */

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const PRODUCT_ITEMS: { label: string; targetId: string; blurb: string }[] = [
  {
    label: "AI Sales Executive",
    targetId: "ai-sales-executive",
    blurb: "Turn enquiries into customers.",
  },
  { label: "AI Receptionist", targetId: "ai-receptionist", blurb: "Your 24/7 front desk." },
  {
    label: "AI Order Booking",
    targetId: "ai-order-booking",
    blurb: "Take bookings. Process orders.",
  },
  {
    label: "AI Customer Care",
    targetId: "ai-customer-care",
    blurb: "Delight your customers, every time.",
  },
];

const INTEGRATION_ITEMS: { label: string; targetId: string }[] = [
  { label: "WhatsApp", targetId: "integrations" },
  { label: "Instagram", targetId: "integrations" },
  { label: "Razorpay", targetId: "integrations" },
  { label: "Google Calendar", targetId: "integrations" },
  { label: "Shopify", targetId: "integrations" },
  { label: "WooCommerce", targetId: "integrations" },
];

const INDUSTRY_ITEMS: { label: string; targetId: string }[] = BUSINESS_TYPES.map((t) => ({
  label: t.label,
  targetId: "industries",
}));

/**
 * A single, self-closing dropdown: click to open, click outside / Escape /
 * item-click to close. Deliberately not Radix's DropdownMenu here — the
 * Industries panel needs a wide, multi-column mega-menu layout the Radix
 * popover isn't built for, so every dropdown in this bar shares this one
 * implementation instead of mixing two different menu systems.
 */
function NavDropdown({
  label,
  panelClassName,
  renderPanel,
}: {
  label: string;
  panelClassName?: string;
  renderPanel: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-sm text-white/70 transition-colors hover:text-white"
      >
        {label}
        <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className={`absolute left-1/2 top-full z-50 mt-3 -translate-x-1/2 rounded-2xl border border-white/10 bg-[#0d0d10] p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)] ${panelClassName ?? "w-72"}`}
        >
          {renderPanel(close)}
        </div>
      ) : null}
    </div>
  );
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
          <NavDropdown
            label="Products"
            panelClassName="w-80"
            renderPanel={(close) => (
              <div className="space-y-1">
                {PRODUCT_ITEMS.map((item) => (
                  <button
                    key={item.targetId}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      close();
                      scrollToSection(item.targetId);
                    }}
                    className="block w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/5"
                  >
                    <span className="block text-sm font-medium text-white">{item.label}</span>
                    <span className="mt-0.5 block text-xs text-white/45">{item.blurb}</span>
                  </button>
                ))}
              </div>
            )}
          />

          <Link to="/pricing" className="text-sm text-white/70 transition-colors hover:text-white">
            Pricing
          </Link>

          <NavDropdown
            label="Integrations"
            panelClassName="w-72"
            renderPanel={(close) => (
              <div className="grid grid-cols-2 gap-1">
                {INTEGRATION_ITEMS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      close();
                      scrollToSection(item.targetId);
                    }}
                    className="rounded-lg px-3 py-2 text-left text-sm text-white/80 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          />

          <NavDropdown
            label="Industries"
            panelClassName="w-[560px]"
            renderPanel={(close) => (
              <div className="grid grid-cols-3 gap-1">
                {INDUSTRY_ITEMS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      close();
                      scrollToSection(item.targetId);
                    }}
                    className="rounded-lg px-3 py-2 text-left text-sm text-white/80 transition-colors hover:bg-white/5 hover:text-white"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          />
        </nav>

        <div className="flex items-center gap-3">
          <Link to="/contact" className="hidden sm:block">
            <Button
              size="sm"
              className="rounded-full bg-white px-5 text-[#0a0a0d] hover:bg-white/90"
            >
              Contact
            </Button>
          </Link>

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
      </div>

      {menuOpen ? (
        <div
          id="landing-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[#0a0a0d] px-6 py-6"
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

          <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col justify-center gap-10 py-10 sm:flex-row sm:items-center sm:justify-between">
            <nav className="flex flex-col gap-1" aria-label="Primary">
              {PRODUCT_ITEMS.map((item) => (
                <button
                  key={item.targetId}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    scrollToSection(item.targetId);
                  }}
                  className="rounded-lg px-2 py-3 text-left font-serif text-3xl text-white/85 hover:text-white sm:text-4xl"
                >
                  {item.label}
                </button>
              ))}
              <Link
                to="/pricing"
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-2 py-3 font-serif text-3xl text-white/85 hover:text-white sm:text-4xl"
              >
                Pricing
              </Link>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  scrollToSection("integrations");
                }}
                className="rounded-lg px-2 py-3 text-left font-serif text-3xl text-white/85 hover:text-white sm:text-4xl"
              >
                Integrations
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  scrollToSection("industries");
                }}
                className="rounded-lg px-2 py-3 text-left font-serif text-3xl text-white/85 hover:text-white sm:text-4xl"
              >
                Industries
              </button>
              <Link
                to="/contact"
                onClick={() => setMenuOpen(false)}
                className="rounded-lg px-2 py-3 font-serif text-3xl text-white/85 hover:text-white sm:text-4xl"
              >
                Contact
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
