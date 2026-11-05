import { useSyncExternalStore } from "react";

/**
 * Homepage light/dark theme: one owner, this module.
 *
 * The `data-vx-theme` attribute on <html> is the single source of truth; React
 * only reads it (useVxTheme), so server and first client render both say "light"
 * and nothing mismatches. Rules:
 *  - THEME_INIT runs before first paint and only sets the attribute if it is not
 *    already set (the router re-runs inline head scripts on client navigation, and
 *    that must never override the current theme). Stored choice wins over the OS.
 *  - localStorage is written only when the user picks a theme, never on init, so
 *    the OS preference is only ever the starting point.
 *  - Clicks only update `desired`; a running transition is never interrupted and
 *    the final desired theme is reconciled once it ends, so rapid clicks end on
 *    the user's last intent.
 *  - Other tabs follow through the `storage` event.
 */

export type VxTheme = "light" | "dark";
export const THEME_KEY = "clickai-theme";

export const THEME_INIT = `try{var d=document.documentElement;if(!d.dataset.vxTheme){var t=localStorage.getItem("${THEME_KEY}");if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";d.dataset.vxTheme=t}}catch(e){}`;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const read = (): VxTheme =>
  document.documentElement.dataset["vxTheme"] === "dark" ? "dark" : "light";

function write(next: VxTheme, persist: boolean) {
  document.documentElement.dataset["vxTheme"] = next;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage blocked: the choice still holds for this page load
    }
  }
  emit();
}

function onStorage(e: StorageEvent) {
  if (e.key !== THEME_KEY || (e.newValue !== "dark" && e.newValue !== "light")) return;
  desired = null;
  if (e.newValue !== read()) write(e.newValue, false);
}

function subscribe(cb: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function useVxTheme(): VxTheme {
  return useSyncExternalStore(subscribe, read, () => "light");
}

let desired: VxTheme | null = null;
let busy = false;
let generation = 0;

type VT = { ready: Promise<void>; finished: Promise<void> };

/**
 * Flips the theme with a circular reveal from `origin` (View Transitions API +
 * clip-path). Going dark the new theme grows out of the button; going light the
 * old (dark) theme shrinks into it. Without the API, or with reduced motion, the
 * switch is instant.
 */
export function toggleTheme(origin: HTMLElement) {
  desired = (desired ?? read()) === "dark" ? "light" : "dark";
  if (busy) return;
  const target = desired;
  if (target === read()) {
    desired = null;
    return;
  }
  const root = document.documentElement;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => VT };
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    write(target, true);
    desired = null;
    return;
  }

  const r = origin.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const grow = target === "dark";
  const mine = ++generation;
  busy = true;

  const finish = () => {
    if (generation !== mine || !busy) return;
    busy = false;
    delete root.dataset["vxVt"];
    // Clicks made during the animation: land on the user's last intent, instantly.
    if (desired !== null && desired !== read()) write(desired, true);
    desired = null;
  };

  // The attribute goes on in the same style recalculation as the theme change (one pass, not two).
  const t = doc.startViewTransition(() => {
    root.dataset["vxVt"] = grow ? "grow" : "shrink";
    write(target, true);
  });
  t.ready
    .then(() => {
      const circle = [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`];
      root.animate(
        { clipPath: grow ? circle : [...circle].reverse() },
        {
          duration: 650,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
          pseudoElement: grow ? "::view-transition-new(root)" : "::view-transition-old(root)",
        },
      );
    })
    .catch(finish);
  t.finished.then(finish, finish);
  // A transition that never starts (page hidden, frames paused) must not strand the theme or lock clicks.
  // Tied to this transition's generation, so it can never act on a later one.
  setTimeout(() => {
    if (generation !== mine || !busy) return;
    write(target, true);
    finish();
  }, 2500);
}
