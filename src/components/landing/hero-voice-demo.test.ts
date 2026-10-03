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
});
