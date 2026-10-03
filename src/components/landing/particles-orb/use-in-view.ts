/**
 * Adapted from VoiceOrbs' Particles Orb (MIT) — see ./LICENSE-voiceorbs.md.
 * Unmodified from source. `useInView` itself isn't consumed here (only
 * `observeActivity`, used directly by use-orb-animator.ts to pause the
 * canvas's requestAnimationFrame loop when it's off-screen or the tab is
 * hidden), kept for parity with upstream and in case a future orb variant
 * needs the hook form.
 */
"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

export const observeActivity = (el: Element, onChange: (active: boolean) => void): (() => void) => {
  let inView = true;
  let pageVisible = document.visibilityState === "visible";
  let active = inView && pageVisible;

  const sync = () => {
    const next = inView && pageVisible;
    if (next === active) return;
    active = next;
    onChange(next);
  };

  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          inView = entries[entries.length - 1]?.isIntersecting ?? true;
          sync();
        });
  observer?.observe(el);

  const onVisibility = () => {
    pageVisible = document.visibilityState === "visible";
    sync();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    observer?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
  };
};

export const useInView = (
  ref: RefObject<Element | null>,
  onChange?: (active: boolean) => void,
): RefObject<boolean> => {
  const activeRef = useRef(true);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const unobserve = observeActivity(el, (active) => {
      activeRef.current = active;
      onChangeRef.current?.(active);
    });
    return () => {
      unobserve();
      activeRef.current = true;
    };
  }, [ref]);

  return activeRef;
};
