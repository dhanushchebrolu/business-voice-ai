import { useEffect, useState } from "react";

/**
 * Tracks the user's prefers-reduced-motion OS setting live (not just at
 * mount) — matches("(prefers-reduced-motion: reduce)") plus a change
 * listener, so a mid-session OS setting change is honored immediately
 * without a page reload. Defaults to `false` on the server (no `window`
 * during SSR) — every consumer's motion-heavy branch must already be
 * conditioned on `typeof window !== "undefined"` / a mount effect for
 * unrelated reasons (canvas/audio APIs don't exist server-side either), so
 * this default never causes a flash of the wrong state on real hydration.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
