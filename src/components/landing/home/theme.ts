import { useSyncExternalStore } from "react";

/**
 * Homepage light/dark theme. The choice lives in localStorage and is applied as
 * `data-vx-theme` on <html> by the inline script in THEME_INIT (runs before first
 * paint, so there is no wrong-theme flash). The attribute is the single source of
 * truth; React only reads it, so server and first client render both say "light"
 * and nothing mismatches.
 */

export type VxTheme = "light" | "dark";
const KEY = "clickai-theme";

export const THEME_INIT = `try{var t=localStorage.getItem("${KEY}");if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset["vxTheme"]=t}catch(e){}`;

const listeners = new Set<() => void>();
const read = (): VxTheme =>
  document.documentElement.dataset["vxTheme"] === "dark" ? "dark" : "light";

export function useVxTheme(): VxTheme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => "light",
  );
}

function apply(next: VxTheme) {
  document.documentElement.dataset["vxTheme"] = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // storage blocked: the choice just won't persist
  }
  listeners.forEach((l) => l());
}

let running = false;

/**
 * Switches theme with a circular reveal from the clicked element (View Transitions
 * API + clip-path). Going dark, the new theme grows out of the button; going back,
 * the old (dark) theme shrinks into it. Falls back to an instant switch when the
 * API is missing or the visitor prefers reduced motion. Clicks during a running
 * transition are ignored.
 */
export function toggleTheme(origin: HTMLElement) {
  if (running) return;
  const next: VxTheme = read() === "dark" ? "light" : "dark";
  const root = document.documentElement;
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> };
  };
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply(next);
    return;
  }
  const r = origin.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const grow = next === "dark";
  running = true;
  root.dataset["vxVt"] = grow ? "grow" : "shrink";
  const t = doc.startViewTransition(() => apply(next));
  const done = () => {
    running = false;
    delete root.dataset["vxVt"];
  };
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
    .catch(done);
  t.finished.then(done, done);
  // A transition that never starts (page hidden, frames paused) must not leave the theme unapplied or clicks locked.
  setTimeout(() => {
    if (!running) return;
    apply(next);
    done();
  }, 2000);
}
