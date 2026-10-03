import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Logo } from "@/components/app/primitives";
import { PublicNav } from "@/components/app/PublicNav";
import { LandingFooter } from "@/components/landing/landing-footer";

export interface LegalTocEntry {
  id: string;
  label: string;
}

/**
 * Shared chrome for every legal/compliance page (Privacy, Terms, Acceptable
 * Use, Messaging, Cookie, Refund, AI Disclaimer, About, Contact) — same
 * header/footer as the rest of the public site, a title + last-updated
 * line, an optional table of contents for long pages, and a consistent
 * reading width. Individual pages supply their own <LegalSection> children.
 */
export function LegalLayout({
  title,
  lastUpdated,
  toc,
  related,
  children,
}: {
  title: string;
  lastUpdated: string;
  toc?: LegalTocEntry[];
  related?: { label: string; to: string }[];
  children: ReactNode;
}) {
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
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {lastUpdated}</p>

        {toc && toc.length > 0 ? (
          <nav
            aria-label="Table of contents"
            className="mt-8 rounded-xl border border-border bg-card p-5"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              On this page
            </p>
            <ol className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {toc.map((entry, i) => (
                <li key={entry.id}>
                  <a
                    href={`#${entry.id}`}
                    className="text-sm text-muted-foreground hover:text-primary"
                  >
                    {i + 1}. {entry.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        <div className="mt-10 space-y-10 text-sm leading-relaxed text-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_li]:mt-1.5 [&_p]:text-muted-foreground [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
          {children}
        </div>

        {related && related.length > 0 ? (
          <div className="mt-14 border-t border-border pt-8">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Related policies
            </p>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
              {related.map((r) => (
                <li key={r.to}>
                  <Link to={r.to} className="text-sm text-primary underline underline-offset-2">
                    {r.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </main>

      <LandingFooter />
    </div>
  );
}

export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
      {children}
    </section>
  );
}
