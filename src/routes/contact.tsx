import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, CheckCircle2, Mail, Phone } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { CLICKAI_LEGAL_NAME, CLICKAI_ADDRESS_LINES } from "@/lib/company-info";
import { Logo } from "@/components/app/primitives";
import { PublicNav } from "@/components/app/PublicNav";
import { LandingFooter } from "@/components/landing/landing-footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact ClickAI | AI Business Automation" },
      {
        name: "description",
        content:
          "Have a question about ClickAI, AI agents, integrations, or getting started? Contact our team by email, phone, or the form below.",
      },
      { property: "og:title", content: "Contact ClickAI" },
      {
        property: "og:description",
        content: "Reach the ClickAI team by email, phone, or the contact form.",
      },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/contact" }],
  }),
  component: Contact,
});

function Contact() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    businessName: "",
    message: "",
  });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!consent) {
      toast.error("Please agree to be contacted before submitting.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.from("demo_requests").insert({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        business_name: form.businessName.trim() || null,
        message: form.message.trim() || null,
        marketing_consent: consent,
      });
      if (error) throw error;
      setSent(true);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not send your request. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

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

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-16">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Contact ClickAI</h1>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground">
          Have a question about ClickAI, AI agents, integrations, or getting started? Contact our
          team.
        </p>

        <div className="mt-10 grid gap-10 lg:grid-cols-[320px_1fr]">
          <div className="space-y-5">
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Email
              </p>
              <a
                href="mailto:hello@clickai.in"
                className="mt-1.5 flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary"
              >
                <Mail className="size-4 text-muted-foreground" /> hello@clickai.in
              </a>
            </div>
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Phone
              </p>
              <a
                href="tel:+917660001231"
                className="mt-1.5 flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary"
              >
                <Phone className="size-4 text-muted-foreground" /> +91 76600 01231
              </a>
            </div>
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Business
              </p>
              <p className="mt-1.5 text-sm font-medium text-foreground">{CLICKAI_LEGAL_NAME}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {CLICKAI_ADDRESS_LINES.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
              </p>
            </div>
          </div>

          <div className="max-w-lg">
            {sent ? (
              <div className="rounded-xl border border-border bg-card p-8 text-center">
                <CheckCircle2 className="mx-auto size-8 text-success" />
                <h2 className="mt-4 text-xl font-semibold tracking-tight">Request received</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Thanks, {form.name || "there"} — someone from the ClickAI team will reach out at{" "}
                  {form.email} to follow up.
                </p>
                <Link to="/" className="mt-6 inline-block">
                  <Button variant="outline">Back to ClickAI</Button>
                </Link>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-semibold tracking-tight">Send us a message</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Tell us a little about your business. A member of the ClickAI team will follow up
                  — no automated booking, a real person will reach out.
                </p>

                <form onSubmit={submit} className="mt-7 space-y-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="contact-name"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Your name
                    </Label>
                    <Input
                      id="contact-name"
                      required
                      value={form.name}
                      onChange={(e) => set("name")(e.target.value)}
                      placeholder="Ravi Sharma"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="contact-email"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Work email
                    </Label>
                    <Input
                      id="contact-email"
                      required
                      type="email"
                      value={form.email}
                      onChange={(e) => set("email")(e.target.value)}
                      placeholder="you@business.com"
                      autoComplete="email"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="contact-business"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Business name
                    </Label>
                    <Input
                      id="contact-business"
                      value={form.businessName}
                      onChange={(e) => set("businessName")(e.target.value)}
                      placeholder="Smile Dental"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="contact-phone"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Phone (optional)
                    </Label>
                    <Input
                      id="contact-phone"
                      value={form.phone}
                      onChange={(e) => set("phone")(e.target.value)}
                      placeholder="+91 98765 43210"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="contact-message"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      What would you like to see? (optional)
                    </Label>
                    <Textarea
                      id="contact-message"
                      value={form.message}
                      onChange={(e) => set("message")(e.target.value)}
                      placeholder="Tell us about your business and what you'd like us to cover."
                      rows={4}
                    />
                  </div>

                  <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface/40 p-3.5">
                    <input
                      id="contact-consent"
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      required
                      className="mt-0.5 size-4 shrink-0 rounded border-border-strong accent-primary"
                    />
                    <Label
                      htmlFor="contact-consent"
                      className="text-xs leading-relaxed text-muted-foreground"
                    >
                      I agree to be contacted by ClickAI regarding my enquiry and services.
                      Communications may include calls, email, WhatsApp messages, or SMS where
                      applicable. Message frequency may vary. Message and data rates may apply where
                      applicable. I can opt out of marketing communications at any time. See our{" "}
                      <Link to="/privacy-policy" className="underline hover:text-foreground">
                        Privacy Policy
                      </Link>
                      ,{" "}
                      <Link to="/terms" className="underline hover:text-foreground">
                        Terms &amp; Conditions
                      </Link>{" "}
                      and{" "}
                      <Link to="/messaging-policy" className="underline hover:text-foreground">
                        Messaging Policy
                      </Link>
                      .
                    </Label>
                  </div>

                  <Button type="submit" className="w-full" disabled={busy || !consent}>
                    {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                    Send message
                  </Button>
                </form>
              </>
            )}
          </div>
        </div>
      </main>

      <LandingFooter />
    </div>
  );
}
