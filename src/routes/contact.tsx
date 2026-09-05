import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Logo } from "@/components/app/primitives";
import { PublicNav } from "@/components/app/PublicNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Book a demo — Vaani" },
      {
        name: "description",
        content:
          "Tell us about your business and the Vaani team will reach out to schedule your demo.",
      },
      { property: "og:title", content: "Book a demo — Vaani" },
      { name: "robots", content: "noindex" },
    ],
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
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { error } = await supabase.from("demo_requests").insert({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        business_name: form.businessName.trim() || null,
        message: form.message.trim() || null,
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
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <Link to="/">
            <Logo />
          </Link>
          <PublicNav />
        </div>
      </header>

      <main className="mx-auto flex max-w-lg flex-col px-5 py-16">
        {sent ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <CheckCircle2 className="mx-auto size-8 text-success" />
            <h1 className="mt-4 text-xl font-semibold tracking-tight">Request received</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Thanks, {form.name || "there"} — someone from the Vaani team will reach out at{" "}
              {form.email} to schedule your demo.
            </p>
            <Link to="/" className="mt-6 inline-block">
              <Button variant="outline">Back to vaani.ai</Button>
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Book a demo</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Tell us a little about your business. A member of the Vaani team will follow up to
              schedule a live walkthrough — no automated booking, a real person will reach out.
            </p>

            <form onSubmit={submit} className="mt-7 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Your name</Label>
                <Input
                  required
                  value={form.name}
                  onChange={(e) => set("name")(e.target.value)}
                  placeholder="Ravi Sharma"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Work email</Label>
                <Input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email")(e.target.value)}
                  placeholder="you@business.com"
                  autoComplete="email"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Business name</Label>
                <Input
                  value={form.businessName}
                  onChange={(e) => set("businessName")(e.target.value)}
                  placeholder="Smile Dental"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  Phone (optional)
                </Label>
                <Input
                  value={form.phone}
                  onChange={(e) => set("phone")(e.target.value)}
                  placeholder="+91 98765 43210"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  What would you like to see? (optional)
                </Label>
                <Textarea
                  value={form.message}
                  onChange={(e) => set("message")(e.target.value)}
                  placeholder="Tell us about your business and what you'd like the demo to cover."
                  rows={4}
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Request a demo
              </Button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
