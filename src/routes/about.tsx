import { createFileRoute, Link } from "@tanstack/react-router";
import { Logo } from "@/components/app/primitives";
import { PublicNav } from "@/components/app/PublicNav";
import { LandingFooter } from "@/components/landing/landing-footer";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About ClickAI | AI Employees for Business" },
      {
        name: "description",
        content:
          "ClickAI is a business automation platform providing AI-powered employees for sales, customer support, appointment bookings and voice/WhatsApp communication.",
      },
      { property: "og:title", content: "About ClickAI" },
      {
        property: "og:description",
        content: "AI employees for sales, support, bookings and business automation.",
      },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/about" }],
  }),
  component: About,
});

function About() {
  return (
    <div className="theme-light flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <Link to="/">
            <Logo />
          </Link>
          <PublicNav />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-16">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">About ClickAI</h1>
        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
          ClickAI is a business automation platform that provides AI-powered employees and
          automation tools for businesses. We help businesses automate repetitive customer
          interactions and operational workflows — the conversations and bookings that would
          otherwise take a person's time every day.
        </p>

        <div className="mt-10 space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">What ClickAI does</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            A ClickAI workspace is built from your actual business details — services, hours,
            pricing and rules you configure — and is designed to cover:
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>AI voice agents that answer business calls</li>
            <li>AI-assisted customer support</li>
            <li>AI sales assistance for inbound enquiries</li>
            <li>Appointment and booking handling</li>
            <li>WhatsApp and messaging automation</li>
            <li>Business workflow automation</li>
          </ul>
        </div>

        <div className="mt-10 space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">How we describe ourselves</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            We don't claim a specific customer count, rating, or certification unless it's true and
            verifiable — if you see a figure like that on this site, it reflects what is actually
            configured and running, not a marketing estimate. Our AI agents are designed to handle
            natural customer conversations; see our{" "}
            <Link to="/ai-disclaimer" className="text-primary underline underline-offset-2">
              AI Disclaimer
            </Link>{" "}
            for the limits of that.
          </p>
        </div>

        <div className="mt-12 rounded-xl border border-border bg-card p-6">
          <h2 className="text-sm font-semibold">Get in touch</h2>
          <p className="mt-2 text-sm text-muted-foreground">ClickAI Private Limited</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Email:{" "}
            <a href="mailto:hello@clickai.in" className="text-primary underline underline-offset-2">
              hello@clickai.in
            </a>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Phone:{" "}
            <a href="tel:+917660001231" className="text-primary underline underline-offset-2">
              +91 76600 01231
            </a>
          </p>
          <div className="mt-4">
            <Link to="/contact">
              <Button size="sm">Contact us</Button>
            </Link>
          </div>
        </div>
      </main>

      <LandingFooter />
    </div>
  );
}
