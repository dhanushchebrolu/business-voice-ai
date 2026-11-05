import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Behavioural tests for the homepage theme owner (theme.ts), run against a fake
 * DOM: persistence, initialisation order, parity of rapid clicks, and the
 * regression where an earlier click's fallback timer flipped a later choice.
 */

type Listener = (e: unknown) => void;
const store = new Map<string, string>();
const root = { dataset: {} as Record<string, string | undefined> };
let osDark = false;
let reduced = false;
let vtCallbacks: Array<() => void> = [];
let vtResolve: Array<() => void> = [];
const timers: Array<{ fn: () => void; ms: number }> = [];

Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
  matchMedia: (q: string) => ({
    matches: q.includes("prefers-color-scheme")
      ? osDark
      : q.includes("reduced-motion")
        ? reduced
        : false,
  }),
  innerWidth: 1000,
  innerHeight: 800,
  window: { addEventListener: (_: string, __: Listener) => {}, removeEventListener: () => {} },
  document: { documentElement: root } as unknown,
  setTimeout: (fn: () => void, ms: number) => void timers.push({ fn, ms }),
});
(root as unknown as { animate: () => void }).animate = () => {};

function enableViewTransitions() {
  (globalThis.document as unknown as Record<string, unknown>)["startViewTransition"] = (
    cb: () => void,
  ) => {
    vtCallbacks.push(cb);
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    vtResolve.push(done);
    return { ready: Promise.resolve(), finished };
  };
}
const origin = {
  getBoundingClientRect: () => ({ left: 900, width: 40, top: 10, height: 40 }),
} as HTMLElement;
const tick = () => new Promise((r) => setImmediate(r));

const { THEME_INIT, THEME_KEY, toggleTheme } = await import("./theme.ts");

beforeEach(() => {
  store.clear();
  root.dataset = {};
  osDark = false;
  reduced = false;
  vtCallbacks = [];
  vtResolve = [];
  timers.length = 0;
  delete (globalThis.document as unknown as Record<string, unknown>)["startViewTransition"];
});

const runInit = () =>
  new Function("document", "localStorage", "matchMedia", THEME_INIT)(
    document,
    localStorage,
    matchMedia,
  );

describe("initialisation (THEME_INIT)", () => {
  test("a stored choice beats the OS preference", () => {
    store.set(THEME_KEY, "light");
    osDark = true;
    runInit();
    assert.equal(root.dataset["vxTheme"], "light");
  });
  test("with nothing stored, the OS preference decides and is not written to storage", () => {
    osDark = true;
    runInit();
    assert.equal(root.dataset["vxTheme"], "dark");
    assert.equal(store.has(THEME_KEY), false);
  });
  test("re-running it (router re-executes head scripts on navigation) never overrides the current theme", () => {
    root.dataset["vxTheme"] = "dark";
    osDark = false;
    store.clear();
    runInit();
    assert.equal(root.dataset["vxTheme"], "dark");
  });
});

describe("toggleTheme", () => {
  test("without View Transitions it flips once and persists", () => {
    root.dataset["vxTheme"] = "light";
    toggleTheme(origin);
    assert.equal(root.dataset["vxTheme"], "dark");
    assert.equal(store.get(THEME_KEY), "dark");
  });
  test("reduced motion skips the transition", () => {
    enableViewTransitions();
    reduced = true;
    root.dataset["vxTheme"] = "light";
    toggleTheme(origin);
    assert.equal(vtCallbacks.length, 0);
    assert.equal(root.dataset["vxTheme"], "dark");
  });
  test("an odd number of rapid clicks flips once; an even number lands back where it started", async () => {
    enableViewTransitions();
    root.dataset["vxTheme"] = "light";
    toggleTheme(origin);
    toggleTheme(origin);
    toggleTheme(origin);
    assert.equal(vtCallbacks.length, 1, "only one transition runs");
    vtCallbacks[0]!();
    vtResolve[0]!();
    await tick();
    await tick();
    assert.equal(root.dataset["vxTheme"], "dark");
    assert.equal(store.get(THEME_KEY), "dark");
    // two more clicks: back to where we were, even count
    vtCallbacks = [];
    toggleTheme(origin);
    toggleTheme(origin);
    vtCallbacks[0]!();
    vtResolve[1]!();
    await tick();
    await tick();
    assert.equal(root.dataset["vxTheme"], "dark");
  });
  test("a stale fallback timer from an earlier transition cannot flip a later choice", async () => {
    enableViewTransitions();
    root.dataset["vxTheme"] = "light";
    toggleTheme(origin); // light -> dark (transition A)
    vtCallbacks[0]!();
    vtResolve[0]!();
    await tick();
    await tick();
    toggleTheme(origin); // dark -> light (transition B, still running)
    vtCallbacks[1]!();
    assert.equal(root.dataset["vxTheme"], "light");
    timers[0]!.fn(); // A's fallback fires late, while B is running
    assert.equal(root.dataset["vxTheme"], "light", "A's timer must not re-apply dark");
    vtResolve[1]!();
    await tick();
    await tick();
    assert.equal(root.dataset["vxTheme"], "light");
    assert.equal(store.get(THEME_KEY), "light");
  });
  test("a transition that never starts is rescued by its own fallback and unlocks clicks", async () => {
    enableViewTransitions();
    root.dataset["vxTheme"] = "light";
    toggleTheme(origin);
    timers[0]!.fn(); // callback never ran; fallback applies the theme
    assert.equal(root.dataset["vxTheme"], "dark");
    toggleTheme(origin);
    assert.equal(vtCallbacks.length, 2, "a new transition can start");
  });
});

describe("single owner", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  test("only theme.ts reads or writes the theme attribute or storage key", () => {
    for (const f of [
      "vx-nav.tsx",
      "primitives.tsx",
      "sections-a.tsx",
      "sections-b.tsx",
      "sections-c.tsx",
      "vx-footer.tsx",
      "product-visuals.tsx",
      "voice-player.tsx",
    ]) {
      const src = readFileSync(join(dir, f), "utf8");
      assert.doesNotMatch(src, /vxTheme|clickai-theme|localStorage/, f);
    }
  });
});
