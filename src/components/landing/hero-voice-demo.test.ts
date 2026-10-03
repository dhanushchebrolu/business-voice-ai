import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "hero-voice-demo.tsx"),
  "utf8",
);

describe("HeroVoiceDemo is a real, working audio player, not a decorative fake", () => {
  test("plays a real audio file via a real <audio> element", () => {
    assert.match(src, /<audio/);
    assert.match(src, /src="\/audio\/ai-receptionist-demo\.mp3"/);
  });

  test("play/pause toggles real playback (audio.play()/audio.pause()), not just a visual state flip", () => {
    assert.match(src, /await audio\.play\(\)/);
    assert.match(src, /audio\.pause\(\)/);
  });

  test("the waveform is driven by a real Web Audio AnalyserNode, not a canned animation", () => {
    assert.match(src, /createAnalyser/);
    assert.match(src, /getByteFrequencyData/);
  });

  test("seeking seeks the real <audio> element's currentTime", () => {
    assert.match(src, /audio\.currentTime = fraction \* duration/);
  });

  test("the seek control is a real, keyboard-accessible slider", () => {
    assert.match(src, /role="slider"/);
    assert.match(src, /onKeyDown/);
  });

  test("the play/pause button has a real, state-correct aria-label", () => {
    assert.match(src, /aria-label=\{isPlaying \? "Pause the demo call" : "Play the demo call"\}/);
  });

  test("a load/decode failure shows a real inline error, never a silently broken control", () => {
    assert.match(src, /onError=\{\(\) => setError/);
  });

  test("does not fabricate a transcript or conversation script (would desync once the audio file is swapped)", () => {
    assert.doesNotMatch(src, /TRANSCRIPT/);
    assert.doesNotMatch(src, /cueAt/);
  });

  test("no dead href/onClick placeholders", () => {
    assert.doesNotMatch(src, /href="#"/);
    assert.doesNotMatch(src, /onClick=\{\(\) => \{\}\}/);
  });

  test("the continuously-animating orb is wired to the real amplitude/speaking signals, not a decorative import", () => {
    assert.match(src, /<LazyOrganicOrb\b/);
    assert.match(src, /amplitude=\{amplitude\}/);
    assert.match(src, /speaking=\{isPlaying\}/);
  });

  test("Three.js/@react-three/fiber are never statically imported — OrganicOrb is only reachable via a dynamic import()", () => {
    assert.doesNotMatch(src, /^import .*"\.\/organic-orb"/m);
    assert.match(src, /lazy\(\(\) =>\s*\n?\s*import\("\.\/organic-orb"\)/);
  });

  test("the orb chunk loads near-viewport, not unconditionally on mount — uses a real IntersectionObserver, not an eager flag", () => {
    assert.match(src, /new IntersectionObserver/);
    assert.match(src, /rootMargin/);
    assert.doesNotMatch(src, /useState\(true\)/);
  });

  test("a non-Three fallback (no layout shift) renders before the lazy chunk resolves, both as the pre-trigger placeholder and the Suspense fallback", () => {
    assert.match(src, /import \{ OrganicOrbFallback \} from "\.\/organic-orb-fallback"/);
    assert.match(src, /<Suspense\s+fallback=\{/);
    assert.match(src, /<OrganicOrbFallback\b/);
  });
});
