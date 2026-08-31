import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

const searchSchema = z.object({
  mode: z.enum(["signin", "signup", "forgot"]).optional(),
  plan: z.string().optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Sign in — Vaani" },
      { name: "description", content: "Sign in or create your Vaani workspace to configure your AI phone receptionist." },
      { property: "og:title", content: "Sign in — Vaani" },
      { property: "og:description", content: "Access your AI receptionist dashboard." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">(search.mode ?? "signin");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    phone: "",
    password: "",
    businessName: "",
    country: "IN",
    terms: false,
  });

  useEffect(() => {
    if (!loading && session) navigate({ to: "/app" });
  }, [loading, session, navigate]);

  const set = (key: keyof typeof form) => (value: string | boolean) => setForm((f) => ({ ...f, [key]: value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        if (!form.terms) {
          toast.error("Please accept the terms to continue.");
          return;
        }
        const { error } = await supabase.auth.signUp({
          email: form.email,
          password: form.password,
          options: {
            emailRedirectTo: `${window.location.origin}/app`,
            data: {
              full_name: form.fullName,
              phone: form.phone,
              business_name: form.businessName,
              country: form.country,
            },
          },
        });
        if (error) throw error;
        toast.success("Workspace created. Check your inbox if email confirmation is required.");
        navigate({ to: "/app" });
      } else if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: form.email, password: form.password });
        if (error) throw error;
        navigate({ to: "/app" });
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(form.email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success("If that email exists, a reset link is on its way.");
        setMode("signin");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setBusy(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
      if (result.error) {
        toast.error("Google sign-in failed. Please try again or use email.");
        return;
      }
      if (result.redirected) return;
      navigate({ to: "/app" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <div className="relative hidden flex-col justify-between border-r border-border bg-surface/40 p-10 lg:flex">
        <div className="grid-noise pointer-events-none absolute inset-0 opacity-50" aria-hidden />
        <Link to="/" className="relative">
          <Logo />
        </Link>
        <div className="relative max-w-sm">
          <h2 className="text-2xl font-semibold leading-snug tracking-tight">
            Your business details in. A receptionist who never misses a call out.
          </h2>
          <p className="mt-4 text-sm text-muted-foreground">
            Configure hours, services, prices and rules once. Vaani compiles them into a versioned voice agent that
            answers in eleven Indian languages.
          </p>
        </div>
        <p className="relative text-xs text-muted-foreground">Secure sign-in · Your workspace is private to your business</p>
      </div>

      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Link to="/">
              <Logo />
            </Link>
          </div>

          <h1 className="text-xl font-semibold tracking-tight">
            {mode === "signup" ? "Create your workspace" : mode === "signin" ? "Sign in" : "Reset your password"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {mode === "signup"
              ? "Create your workspace. Activation takes a one-time setup payment."
              : mode === "signin"
                ? "Welcome back. Pick up where your receptionist left off."
                : "We'll email you a link to set a new password."}
          </p>

          <form onSubmit={onSubmit} className="mt-7 space-y-4">
            {mode === "signup" ? (
              <>
                <Field label="Full name">
                  <Input required value={form.fullName} onChange={(e) => set("fullName")(e.target.value)} placeholder="Ravi Sharma" />
                </Field>
                <Field label="Business name">
                  <Input required value={form.businessName} onChange={(e) => set("businessName")(e.target.value)} placeholder="Smile Dental" />
                </Field>
                <Field label="Phone">
                  <Input required value={form.phone} onChange={(e) => set("phone")(e.target.value)} placeholder="+91 98765 43210" />
                </Field>
              </>
            ) : null}

            <Field label="Business email">
              <Input
                required
                type="email"
                value={form.email}
                onChange={(e) => set("email")(e.target.value)}
                placeholder="you@business.com"
                autoComplete="email"
              />
            </Field>

            {mode !== "forgot" ? (
              <Field label="Password">
                <Input
                  required
                  type="password"
                  minLength={8}
                  value={form.password}
                  onChange={(e) => set("password")(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                />
              </Field>
            ) : null}

            {mode === "signup" ? (
              <label className="flex items-start gap-2.5 text-xs text-muted-foreground">
                <Checkbox checked={form.terms} onCheckedChange={(v) => set("terms")(Boolean(v))} className="mt-0.5" />
                <span>I accept the terms of service and confirm I am authorised to configure calls for this business.</span>
              </label>
            ) : null}

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {mode === "signup" ? "Create workspace" : mode === "signin" ? "Sign in" : "Send reset link"}
            </Button>
          </form>

          {mode !== "forgot" ? (
            <>
              <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-widest text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
              </div>
              <Button variant="outline" className="w-full" onClick={onGoogle} disabled={busy}>
                Continue with Google
              </Button>
            </>
          ) : null}

          <div className="mt-6 space-y-2 text-sm text-muted-foreground">
            {mode === "signin" ? (
              <>
                <button className="text-primary hover:underline" onClick={() => setMode("forgot")}>
                  Forgot your password?
                </button>
                <p>
                  New here?{" "}
                  <button className="text-primary hover:underline" onClick={() => setMode("signup")}>
                    Create a workspace
                  </button>
                </p>
              </>
            ) : (
              <p>
                Already have an account?{" "}
                <button className="text-primary hover:underline" onClick={() => setMode("signin")}>
                  Sign in
                </button>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
