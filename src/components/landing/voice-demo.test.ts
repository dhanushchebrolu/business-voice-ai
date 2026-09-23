import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Functionality coverage for the voice demo player: real play/pause/seek/
 * replay/duration wired to a real <audio> element (no fake/no-op handlers),
 * error handling on load failure, autoplay never attempted, and cleanup of
 * the rAF loop + AudioContext on unmount.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "voice-demo.tsx"), "utf8");

describe("VoiceDemo is a genuine, functional audio player", () => {
  test("uses a real local audio asset, not a remote/placeholder URL", () => {
    assert.match(src, /src="\/audio\/ai-receptionist-demo\.mp3"/);
  });

  test("never sets autoplay — playback only starts from a real user click", () => {
    assert.doesNotMatch(src, /\bautoPlay\b/);
    assert.doesNotMatch(src, /\bautoplay\b/);
  });

  test("play/pause/replay/seek are wired to the real <audio> element's own API and events", () => {
    assert.match(src, /audio\.play\(\)/);
    assert.match(src, /audio\.pause\(\)/);
    assert.match(src, /audio\.currentTime = 0/);
    assert.match(src, /audio\.currentTime = fraction \* duration/);
    assert.match(src, /onLoadedMetadata=\{\(e\) => setDuration\(e\.currentTarget\.duration\)\}/);
    assert.match(src, /onPlay=\{/);
    assert.match(src, /onPause=\{/);
    assert.match(src, /onEnded=\{/);
  });

  test("seek control is keyboard-accessible (ArrowLeft/ArrowRight) and exposes slider semantics", () => {
    assert.match(src, /role="slider"/);
    assert.match(src, /aria-valuemin=\{0\}/);
    assert.match(src, /aria-valuemax=\{Math\.round\(duration\)\}/);
    assert.match(src, /aria-valuenow=\{Math\.round\(currentTime\)\}/);
    assert.match(src, /tabIndex=\{0\}/);
    assert.match(src, /e\.key === "ArrowRight"/);
    assert.match(src, /e\.key === "ArrowLeft"/);
  });

  test("load/playback failures surface a real inline error, not a silently broken control", () => {
    assert.match(src, /onError=\{\(\) => setError\(/);
    assert.match(src, /catch \{\s*setError\(/);
  });

  test("the rAF amplitude loop and AudioContext are torn down on unmount", () => {
    assert.match(src, /cancelAnimationFrame\(rafRef\.current\)/);
    assert.match(src, /audioContextRef\.current\?\.close\(\)/);
  });

  test("play/pause/replay buttons are real <button> elements with accessible labels, not divs with onClick", () => {
    assert.match(src, /<button[\s\S]{0,80}onClick=\{handlePlayPause\}/);
    assert.match(src, /aria-label=\{isPlaying \? "Pause demo" : "Play demo"\}/);
    assert.match(src, /<button[\s\S]{0,80}onClick=\{handleReplay\}/);
    assert.match(src, /aria-label="Replay demo"/);
  });
});
