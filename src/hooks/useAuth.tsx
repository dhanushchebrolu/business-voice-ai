import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // AuthProvider wraps every route via __root.tsx, including the public
    // marketing site — a Supabase misconfiguration (missing env vars, a
    // network hiccup, a bad URL) must degrade to "signed out," never crash
    // the entire page. `supabase` is a lazy Proxy (client.ts) that can throw
    // synchronously the moment `.auth` is first touched, so this whole block
    // is wrapped rather than just the async call. Protected routes (/app,
    // /admin) treat session:null the same way they treat an unauthenticated
    // visitor — redirect to /auth — so falling back here is fail-safe, not
    // fail-open: nothing is granted access as a result of this catch.
    try {
      const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
        setSession(next);
        setLoading(false);
      });
      supabase.auth
        .getSession()
        .then(({ data }) => {
          setSession(data.session);
          setLoading(false);
        })
        .catch((error: unknown) => {
          console.error("auth:get_session_failed", error);
          setSession(null);
          setLoading(false);
        });
      return () => sub.subscription.unsubscribe();
    } catch (error) {
      console.error("auth:client_unavailable", error);
      setSession(null);
      setLoading(false);
      return undefined;
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
