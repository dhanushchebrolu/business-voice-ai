import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Set a new password — Vaani" },
      { name: "description", content: "Choose a new password for your Vaani workspace." },
      { property: "og:title", content: "Set a new password — Vaani" },
      { property: "og:description", content: "Choose a new password for your Vaani workspace." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const { session, loading } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // The reset link establishes a recovery session via the URL hash. If
    // there is none once auth has finished loading, the link is invalid or
    // has already expired — say so rather than letting updateUser fail
    // silently with an opaque error.
    if (!loading && !session) setLinkInvalid(true);
  }, [loading, session]);

  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated. Please sign in again.");
      await supabase.auth.signOut();
      navigate({ to: "/auth" });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update your password. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (linkInvalid) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <Logo className="mb-6" />
        <h1 className="text-lg font-semibold tracking-tight">
          This reset link is invalid or has expired
        </h1>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Request a new password reset link and open it in this browser.
        </p>
        <Link to="/auth" search={{ mode: "forgot" }} className="mt-6">
          <Button>Request a new link</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <Link to="/">
          <Logo />
        </Link>
        <h1 className="mt-8 text-xl font-semibold tracking-tight">Set a new password</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Choose a new password for your account.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">New password</Label>
            <PasswordInput
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              fieldLabel="new password"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Confirm new password</Label>
            <PasswordInput
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your new password"
              autoComplete="new-password"
              fieldLabel="confirm new password"
            />
            {mismatch ? <p className="text-xs text-destructive">Passwords do not match.</p> : null}
          </div>
          <Button className="w-full" disabled={busy || mismatch || password.length < 8}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}Update password
          </Button>
        </form>
      </div>
    </div>
  );
}
