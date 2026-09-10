import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { resolvePostAuthDestination } from "@/lib/post-auth-destination";
import { Logo } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/auth/callback")({
  head: () => ({
    meta: [{ title: "Signing you in — Vaani" }, { name: "robots", content: "noindex" }],
  }),
  component: AuthCallback,
});

type CallbackError = "no-session" | "resolve-failed";

/**
 * Landing point for both the Google OAuth broker redirect and the email
 * confirmation link, replacing a bare redirect to "/". Supabase's client
 * auto-detects the session from the URL (default detectSessionInUrl); this
 * page just waits for that, then routes to the correct destination using the
 * same backend-authoritative resolver as every other sign-in path — never a
 * blind redirect to the customer dashboard or the public home page.
 *
 * Both failure modes below are terminal, user-visible states with a retry
 * path — this page never leaves the visitor stuck on "Completing sign-in…"
 * indefinitely.
 */
function AuthCallback() {
  const { session, loading, user } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<CallbackError | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!session || !user) {
      // Give Supabase a brief moment to finish parsing the URL hash before
      // concluding sign-in genuinely failed (invalid/expired link, or the
      // OAuth broker returned an error).
      const t = setTimeout(() => setError("no-session"), 2500);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    resolvePostAuthDestination(user.id)
      .then((dest) => {
        if (!cancelled) navigate({ to: dest });
      })
      .catch((err) => {
        console.error("auth_callback:resolve_destination_failed", err);
        if (!cancelled) setError("resolve-failed");
      });
    return () => {
      cancelled = true;
    };
  }, [loading, session, user, navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <Logo className="mb-6" />
        <h1 className="text-lg font-semibold tracking-tight">
          {error === "resolve-failed"
            ? "Something went wrong finishing sign-in"
            : "Sign-in didn't complete"}
        </h1>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {error === "resolve-failed"
            ? "You're signed in, but we couldn't load your account details. Please try again."
            : "That link may have expired, or Google sign-in was cancelled. Please try again."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Try again</Button>
          <Link to="/auth">
            <Button variant="outline">Back to sign in</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Completing sign-in…
    </div>
  );
}
