import { useEffect } from "react";

/**
 * In-page navigation for the homepage. Every `#section` link (header, hero, footer,
 * mobile menu) scrolls to its section, adds a history entry, and supports back,
 * forward and direct hash URLs.
 *
 * The scroll is our own short tween that re-measures the target every frame instead
 * of the browser's one-shot smooth scroll: off-screen sections only get their real
 * height when they are reached, so a fixed destination computed at the start can end
 * up hundreds of pixels off. A newer navigation, or the visitor scrolling, cancels
 * the one in progress. Reduced motion jumps instead of animating.
 */

const DURATION = 650;
let cancel: (() => void) | null = null;

function scrollToId(id: string, animate: boolean) {
  const el = document.getElementById(id);
  if (!el) return;
  cancel?.();
  const offset = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  const target = () => Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const from = window.scrollY;
  const start = performance.now();
  let raf = 0;
  let stop = false;
  let extra = 0;
  const settle = () => {
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
  };
  const frame = (now: number) => {
    if (stop) return;
    const t = reduce || !animate ? 1 : Math.min(1, (now - start) / DURATION);
    const eased = 1 - Math.pow(1 - t, 3);
    const to = target();
    window.scrollTo({ top: from + (to - from) * eased, behavior: "instant" });
    if (t < 1) raf = requestAnimationFrame(frame);
    else if (Math.abs(target() - window.scrollY) > 1 && extra++ < 100)
      raf = requestAnimationFrame(frame); // layout moved under us: keep correcting (bounded: the page end may not reach)
    else {
      settle();
      // Sections rendering late (images, fonts, skipped sections) keep moving the target: follow it briefly.
      const ro = new ResizeObserver(() => {
        const d = target() - window.scrollY;
        if (Math.abs(d) > 1) window.scrollTo({ top: target(), behavior: "instant" });
      });
      ro.observe(document.body);
      const timer = window.setTimeout(() => cancel?.(), 2500);
      const prev = cancel;
      cancel = () => {
        ro.disconnect();
        window.clearTimeout(timer);
        prev?.();
      };
    }
  };
  const interrupt = () => cancel?.();
  cancel = () => {
    stop = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("wheel", interrupt);
    window.removeEventListener("touchstart", interrupt);
    window.removeEventListener("keydown", interrupt);
    cancel = null;
  };
  window.addEventListener("wheel", interrupt, { passive: true, once: true });
  window.addEventListener("touchstart", interrupt, { passive: true, once: true });
  window.addEventListener("keydown", interrupt, { once: true });
  raf = requestAnimationFrame(frame);
}

export function useAnchorScroll() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const a =
        e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
      const id = a?.getAttribute("href")?.slice(1);
      if (!a || !id || !document.getElementById(id)) return;
      e.preventDefault();
      if (location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
      scrollToId(id, true);
    };
    // Back/forward and typed hashes: the browser has already jumped using stale heights, so re-aim.
    const onHash = () => scrollToId(location.hash.slice(1), false);
    document.addEventListener("click", onClick);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    // A reload keeps the hash but the browser also restores the old scroll position afterwards; the hash wins.
    if (location.hash) {
      history.scrollRestoration = "manual";
      scrollToId(location.hash.slice(1), false);
      // Fonts and images still arriving can move sections after the first jump.
      if (document.readyState !== "complete") {
        window.addEventListener("load", () => scrollToId(location.hash.slice(1), false), {
          once: true,
        });
      }
    }
    return () => {
      cancel?.();
      history.scrollRestoration = "auto";
      document.removeEventListener("click", onClick);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);
}
