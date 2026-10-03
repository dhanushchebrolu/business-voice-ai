/**
 * Adapted from VoiceOrbs' Particles Orb (MIT) — see ./LICENSE-voiceorbs.md.
 * Unmodified from source. Deliberately plain functions (not a React hook):
 * use-orb-animator.ts reads `prefersReducedMotion()` fresh on every
 * requestAnimationFrame tick inside its own imperative loop, and
 * subscribes to changes directly, without going through a React re-render.
 * This project's own `usePrefersReducedMotion` hook (src/hooks) is for
 * render-time consumption and isn't a fit for that loop.
 */
"use client";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches;

export const subscribeReducedMotion = (onChange: () => void): (() => void) => {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};
