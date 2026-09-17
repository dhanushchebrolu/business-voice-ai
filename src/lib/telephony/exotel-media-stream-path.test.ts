import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXOTEL_MEDIA_STREAM_PATH } from "./exotel-media-stream-path.ts";

test("the canonical media-stream path is exactly what PHASE_D1_EXOTEL_FINAL_REPORT.md documents as the Exotel Voicebot Applet's WSS URL path", () => {
  assert.equal(EXOTEL_MEDIA_STREAM_PATH, "/api/public/media-stream/exotel");
});

test("REGRESSION (production incident: start_runtime_no_bridge, waitedMs 15000 — Exotel never opened the media WebSocket at all): every consumer of this path imports the single shared constant, never a re-declared local copy that could silently drift from it", () => {
  const consumers = [
    new URL("./exotel-media-route.server.ts", import.meta.url),
    new URL("./call-session-durable-object.server.ts", import.meta.url),
    new URL("../../server.ts", import.meta.url),
  ];
  for (const fileUrl of consumers) {
    const source = readFileSync(fileUrl, "utf8");
    assert.match(
      source,
      /import\s*\{\s*EXOTEL_MEDIA_STREAM_PATH(?:\s+as\s+MEDIA_STREAM_PATH)?\s*\}\s*from\s*["'][^"']*exotel-media-stream-path(?:\.ts)?["']/,
      `expected ${fileUrl.pathname} to import EXOTEL_MEDIA_STREAM_PATH from the shared module`,
    );
    assert.doesNotMatch(
      source,
      /const\s+MEDIA_STREAM_PATH\s*=\s*["']/,
      `expected ${fileUrl.pathname} to have no locally re-declared MEDIA_STREAM_PATH constant`,
    );
  }
});
