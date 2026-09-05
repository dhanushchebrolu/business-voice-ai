import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useAuth } from "@/hooks/useAuth";
import { resolvePostAuthDestination } from "@/lib/post-auth-destination";
import { Logo } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

const searchSchema = z.object({
  mode: z.enum(["signin", "signup", "forgot"]).optional(),
  plan: z.string().optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Sign in — Vaani" },
      {
        name: "description",
        content: "Sign in or create your Vaani workspace to configure your AI phone receptionist.",
      },
      { property: "og:title", content: "Sign in — Vaani" },
      { property: "og:description", content: "Access your AI receptionist dashboard." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

const RESEND_COOLDOWN_SECONDS = 60;

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { session, loading, user } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">(search.mode ?? "signin");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    phone: "",
    password: "",
    confirmPassword: "",
    businessName: "",
    country: "IN",
    terms: false,
  });

  // Post-signup email verification step. Not URL-driven — it's an ephemeral
  // continuation of the signup form, scoped to this component only.
  const [step, setStep] = useState<"form" | "verify">("form");
  const [pendingEmail, setPendingEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    if (loading || !session || !user) return;
    let cancelled = false;
    resolvePostAuthDestination(user.id)
      .then((dest) => {
        if (!cancelled) navigate({ to: dest });
      })
      .catch((error) => {
        // Never leave the visitor stuck: on failure, just stay on this page
        // (the sign-in form below is still fully usable) instead of hanging
        // in a state with no visible way forward.
        console.error("auth:resolve_destination_failed", error);
        if (!cancelled) {
          toast.error("Could not load your account. Please try again or reload the page.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loading, session, user, navigate]);

  const set = (key: keyof typeof form) => (value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        if (!form.terms) {
          toast.error("Please accept the terms to continue.");
          return;
        }
        if (form.password !== form.confirmPassword) {
          toast.error("Passwords do not match.");
          return;
        }
        const { data, error } = await supabase.auth.signUp({
          email: form.email,
          password: form.password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
            data: {
              full_name: form.fullName,
              phone: form.phone,
              business_name: form.businessName,
              country: form.country,
            },
          },
        });
        if (error) throw error;

        if (data.session && data.user) {
          // Email confirmation is disabled for this Supabase project — there
          // is nothing to verify. Proceed directly rather than showing a
          // verification screen with nothing to enter.
          toast.success("Account created.");
          const dest = await resolvePostAuthDestination(data.user.id);
          navigate({ to: dest });
        } else {
          setPendingEmail(form.email);
          setOtp("");
          setOtpError(null);
          setCooldown(RESEND_COOLDOWN_SECONDS);
          setStep("verify");
        }
      } else if (mode === "signin") {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: form.email,
          password: form.password,
        });
        if (error) throw error;
        const dest = await resolvePostAuthDestination(data.user.id);
        navigate({ to: dest });
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(form.email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success("If that email exists, a reset link is on its way.");
        setMode("signin");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Something went wrong. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyOtp() {
    if (otp.length !== 6) return;
    setOtpBusy(true);
    setOtpError(null);
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: pendingEmail,
        token: otp,
        type: "signup",
      });
      if (error) {
        if (/expired/i.test(error.message)) {
          setOtpError("This code has expired. Request a new one below.");
        } else {
          setOtpError("That code isn't correct. Please check your inbox and try again.");
        }
        return;
      }
      toast.success("Email verified.");
      const dest = await resolvePostAuthDestination(data.user!.id);
      navigate({ to: dest });
    } catch (error) {
      setOtpError(
        error instanceof Error ? error.message : "Could not verify that code. Please try again.",
      );
    } finally {
      setOtpBusy(false);
    }
  }

  async function onResendOtp() {
    if (cooldown > 0 || resendBusy) return;
    setResendBusy(true);
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email: pendingEmail });
      if (error) throw error;
      toast.success("A new code is on its way.");
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setOtpError(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not resend the code. Please try again.",
      );
    } finally {
      setResendBusy(false);
    }
  }

  async function onGoogle() {
    setBusy(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: `${window.location.origin}/auth/callback`,
      });
      if (result.error) {
        toast.error("Google sign-in failed. Please try again or use email.");
        return;
      }
      if (result.redirected) return;
      // Non-redirect (popup/iframe) path: tokens were already applied to the
      // Supabase client by src/integrations/lovable/index.ts. Route the same
      // way the callback page would.
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        const dest = await resolvePostAuthDestination(data.user.id);
        navigate({ to: dest });
      }
    } finally {
      setBusy(false);
    }
  }

  if (step === "verify") {
    return (
      <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
        <div className="relative hidden flex-col justify-between border-r border-border bg-surface/40 p-10 lg:flex">
          <div className="grid-noise pointer-events-none absolute inset-0 opacity-50" aria-hidden />
          <Link to="/" className="relative">
            <Logo />
          </Link>
          <div className="relative max-w-sm">
            <h2 className="text-2xl font-semibold leading-snug tracking-tight">
              Check your inbox.
            </h2>
            <p className="mt-4 text-sm text-muted-foreground">
              We sent a 6-digit code to {pendingEmail}. Enter it to verify your email and finish
              creating your account.
            </p>
          </div>
          <p className="relative text-xs text-muted-foreground">
            Secure sign-up · Codes expire after a short time
          </p>
        </div>

        <div className="flex items-center justify-center px-5 py-12">
          <div className="w-full max-w-sm text-center">
            <div className="mb-8 lg:hidden">
              <Link to="/">
                <Logo />
              </Link>
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Verify your email</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Enter the 6-digit code we sent to{" "}
              <span className="font-medium text-foreground">{pendingEmail}</span>.
            </p>

            <div className="mt-7 flex justify-center">
              <InputOTP maxLength={6} value={otp} onChange={setOtp} disabled={otpBusy}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            {otpError ? <p className="mt-3 text-sm text-destructive">{otpError}</p> : null}

            <Button
              className="mt-6 w-full"
              disabled={otp.length !== 6 || otpBusy}
              onClick={onVerifyOtp}
            >
              {otpBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Verify
            </Button>

            <button
              type="button"
              className="mt-4 text-sm text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
              onClick={onResendOtp}
              disabled={cooldown > 0 || resendBusy}
            >
              {resendBusy
                ? "Sending…"
                : cooldown > 0
                  ? `Resend code in ${cooldown}s`
                  : "Resend code"}
            </button>

            <p className="mt-6">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={() => {
                  setStep("form");
                  setMode("signin");
                }}
              >
                Back to sign in
              </button>
            </p>
          </div>
        </div>
      </div>
    );
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
            Configure hours, services, prices and rules once. Vaani compiles them into a versioned
            voice agent that answers in eleven Indian languages.
          </p>
        </div>
        <p className="relative text-xs text-muted-foreground">
          Secure sign-in · Your workspace is private to your business
        </p>
      </div>

      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Link to="/">
              <Logo />
            </Link>
          </div>

          <h1 className="text-xl font-semibold tracking-tight">
            {mode === "signup"
              ? "Create your workspace"
              : mode === "signin"
                ? "Sign in"
                : "Reset your password"}
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
                  <Input
                    required
                    value={form.fullName}
                    onChange={(e) => set("fullName")(e.target.value)}
                    placeholder="Ravi Sharma"
                  />
                </Field>
                <Field label="Business name">
                  <Input
                    required
                    value={form.businessName}
                    onChange={(e) => set("businessName")(e.target.value)}
                    placeholder="Smile Dental"
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    required
                    value={form.phone}
                    onChange={(e) => set("phone")(e.target.value)}
                    placeholder="+91 98765 43210"
                  />
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
                <PasswordInput
                  required
                  minLength={8}
                  value={form.password}
                  onChange={(e) => set("password")(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  fieldLabel="password"
                />
              </Field>
            ) : null}

            {mode === "signup" ? (
              <Field label="Confirm password">
                <PasswordInput
                  required
                  minLength={8}
                  value={form.confirmPassword}
                  onChange={(e) => set("confirmPassword")(e.target.value)}
                  placeholder="Re-enter your password"
                  autoComplete="new-password"
                  fieldLabel="confirm password"
                />
                {form.confirmPassword.length > 0 && form.confirmPassword !== form.password ? (
                  <p className="text-xs text-destructive">Passwords do not match.</p>
                ) : null}
              </Field>
            ) : null}

            {mode === "signup" ? (
              <label className="flex items-start gap-2.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={form.terms}
                  onCheckedChange={(v) => set("terms")(Boolean(v))}
                  className="mt-0.5"
                />
                <span>
                  I accept the terms of service and confirm I am authorised to configure calls for
                  this business.
                </span>
              </label>
            ) : null}

            <Button
              type="submit"
              className="w-full"
              disabled={
                busy ||
                (mode === "signup" &&
                  form.confirmPassword.length > 0 &&
                  form.confirmPassword !== form.password)
              }
            >
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {mode === "signup"
                ? "Create workspace"
                : mode === "signin"
                  ? "Sign in"
                  : "Send reset link"}
            </Button>
          </form>

          {mode !== "forgot" ? (
            <>
              <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-widest text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> or{" "}
                <span className="h-px flex-1 bg-border" />
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
                  <button
                    className="text-primary hover:underline"
                    onClick={() => setMode("signup")}
                  >
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
