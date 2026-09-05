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

/**
 * Landing point for both the Google OAuth broker redirect and the email
 * confirmation link, replacing a bare redirect to "/". Supabase's client
 * auto-detects the session from the URL (default detectSessionInUrl); this
 * page just waits for that, then routes to the correct destination using the
 * same backend-authoritative resolver as every other sign-in path — never a
 * blind redirect to the customer dashboard or the public home page.
 */
function AuthCallback() {
  const { session, loading, user } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!session || !user) {
      // Give Supabase a brief moment to finish parsing the URL hash before
      // concluding sign-in genuinely failed (invalid/expired link, or the
      // OAuth broker returned an error).
      const t = setTimeout(() => setFailed(true), 2500);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    resolvePostAuthDestination(user.id).then((dest) => {
      if (!cancelled) navigate({ to: dest });
    });
    return () => {
      cancelled = true;
    };
  }, [loading, session, user, navigate]);

  if (failed) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <Logo className="mb-6" />
        <h1 className="text-lg font-semibold tracking-tight">Sign-in didn't complete</h1>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          That link may have expired, or Google sign-in was cancelled. Please try again.
        </p>
        <Link to="/auth" className="mt-6">
          <Button>Back to sign in</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Completing sign-in…
    </div>
  );
}
