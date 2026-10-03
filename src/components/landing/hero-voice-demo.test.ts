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

  test("the particle orb is wired to the real playback state and a live levelRef, not a decorative import", () => {
    assert.match(src, /<LazyParticlesOrb\b/);
    assert.match(src, /state=\{isPlaying \? "speaking" : "idle"\}/);
    assert.match(src, /levelRef=\{orbLevelRef\}/);
  });

  test('the real AnalyserNode amplitude drives the orb\'s levelRef every tick, and resets to -1 (its documented "fall back to procedural animation" value) on pause/end — never a fabricated constant', () => {
    assert.match(src, /orbLevelRef\.current = avg;/);
    assert.match(src, /onPause=\{\(\) => \{[\s\S]{0,120}orbLevelRef\.current = -1;/);
    assert.match(src, /onEnded=\{\(\) => \{[\s\S]{0,120}orbLevelRef\.current = -1;/);
  });

  test("ParticlesOrb is never statically imported — it's only reachable via a dynamic import()", () => {
    assert.doesNotMatch(src, /^import .*"\.\/particles-orb\/particles-orb"/m);
    assert.match(src, /lazy\(\(\) =>\s*\n?\s*import\("\.\/particles-orb\/particles-orb"\)/);
  });

  test("the orb chunk loads near-viewport, not unconditionally on mount — uses a real IntersectionObserver, not an eager flag", () => {
    assert.match(src, /new IntersectionObserver/);
    assert.match(src, /rootMargin/);
    assert.doesNotMatch(src, /useState\(true\)/);
  });

  test("a fallback (no layout shift) renders before the lazy chunk resolves, both as the pre-trigger placeholder and the Suspense fallback", () => {
    assert.match(
      src,
      /import \{ ParticlesOrbFallback \} from "\.\/particles-orb\/particles-orb-fallback"/,
    );
    assert.match(src, /<Suspense\s+fallback=\{/);
    assert.match(src, /<ParticlesOrbFallback\b/);
  });

  test("the orb's canvas size tracks the button's real rendered size via ResizeObserver, so it's genuinely responsive rather than fixed/stretched", () => {
    assert.match(src, /new ResizeObserver/);
    assert.match(src, /size=\{orbSize\}/);
  });
});
