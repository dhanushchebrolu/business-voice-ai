import { createFileRoute, Link } from "@tanstack/react-router";
import { PhoneCall, Languages, ShieldCheck, GitBranch, Gauge, ArrowRight } from "lucide-react";
import { Logo, StatusPill } from "@/components/app/primitives";
import { PublicNav } from "@/components/app/PublicNav";
import { Button } from "@/components/ui/button";
import { LANGUAGES } from "@/lib/voices";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Vaani — AI phone receptionist for Indian businesses" },
      {
        name: "description",
        content:
          "Vaani answers every business call in 11 Indian languages using your own hours, services, prices and rules. Set it up from a form, not a prompt.",
      },
      { property: "og:title", content: "Vaani — AI phone receptionist for Indian businesses" },
      {
        property: "og:description",
        content:
          "Your business details become a voice agent that answers calls, quotes your prices and captures leads.",
      },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  {
    icon: PhoneCall,
    title: "Answers every call",
    body: "Missed calls become booked appointments. Your receptionist picks up on the first ring, day or night.",
  },
  {
    icon: Languages,
    title: "Eleven Indian languages",
    body: "English, Hindi, Telugu, Tamil, Bengali and more — with natural voices and per-language greetings.",
  },
  {
    icon: GitBranch,
    title: "Grounded in your data",
    body: "Hours, services, prices, FAQs and rules you enter become the agent's instructions. Nothing is invented.",
  },
  {
    icon: ShieldCheck,
    title: "Rules you control",
    body: "Never quote outside your price list. Never confirm a booking without a check. Escalate when unsure.",
  },
  {
    icon: Gauge,
    title: "Versioned configuration",
    body: "Every change publishes a new agent version you can review, compare and roll back.",
  },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <Logo />
          <PublicNav />
        </div>
      </header>

      <section className="relative overflow-hidden border-b border-border">
        <div className="grid-noise pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-5 py-20 sm:py-28">
          <StatusPill tone="accent">Voice agents for Indian businesses</StatusPill>
          <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
            A receptionist that knows your business by heart.
          </h1>
          <p className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
            Fill in your hours, services, prices and rules. Vaani turns them into a phone agent that
            answers your customers in their language — and logs every call, transcript and lead in
            your dashboard.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/auth" search={{ mode: "signup" }}>
              <Button size="lg">
                Create your workspace <ArrowRight className="ml-1.5 size-4" />
              </Button>
            </Link>
            <Link to="/pricing">
              <Button size="lg" variant="outline">
                See pricing
              </Button>
            </Link>
          </div>
          <div className="mt-10 flex flex-wrap gap-1.5">
            {LANGUAGES.map((l) => (
              <span
                key={l.code}
                className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted-foreground"
              >
                {l.native}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          What you get
        </h2>
        <div className="mt-6 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-card p-6">
              <f.icon className="size-4 text-primary" />
              <h3 className="mt-4 text-sm font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
          <div className="flex flex-col justify-between bg-card p-6">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Bring your own telephony or use a number we provision for you. Everything else is
              already wired.
            </p>
            <Link
              to="/auth"
              search={{ mode: "signup" }}
              className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary"
            >
              Get started <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-surface/40">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-16 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">How a call actually works</h2>
            <p className="mt-3 text-sm text-muted-foreground">
              You never write a prompt. Your structured business data is compiled server-side into
              the agent's instructions and published as a version.
            </p>
          </div>
          <ol className="space-y-3">
            {[
              "Customer dials your business number",
              "Telephony streams the audio to the voice runtime",
              "Speech recognition transcribes in the caller's language",
              "Your published agent version answers with your data",
              "Speech synthesis replies in your chosen voice",
              "Transcript, summary and lead land in your dashboard",
            ].map((step, i) => (
              <li
                key={step}
                className="flex items-start gap-3 rounded-md border border-border bg-card px-4 py-3"
              >
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-primary/15 text-[11px] font-semibold text-primary tabular">
                  {i + 1}
                </span>
                <span className="text-sm">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <Logo />
          <p>© {new Date().getFullYear()} Vaani. Built for businesses that answer the phone.</p>
        </div>
      </footer>
    </div>
  );
}
