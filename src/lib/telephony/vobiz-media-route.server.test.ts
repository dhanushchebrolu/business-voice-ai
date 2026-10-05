import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for vobiz-media-route.server.ts — the local-dev /
 * no-Durable-Object fallback path for Vobiz media (see
 * vobiz-call-session-durable-object.server.test.ts for the production
 * Durable Object path's own, behavioral coverage of this exact fix, using
 * its real WebSocketPair-based test harness).
 *
 * This file had no dedicated test file before the media-session-token
 * production incident fix — its behavior was covered only indirectly via
 * vobiz-provider.test.ts/vobiz-answer.test.ts. Source-scan, matching this
 * repo's established convention for files this Node-native test runner
 * can exercise structurally but not (without a live Supabase instance)
 * fully behaviorally.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "vobiz-media-route.server.ts"),
  "utf8",
);

describe("vobiz-media-route.server.ts: media-session token fix (production incident — Klyro never mints a token for Vobiz, so reading a top-level 'token'/'session_token' field from Vobiz's own start event could only ever be Vobiz's own, unrelated data)", () => {
  test("no longer extracts a 'token'/'session_token' field from the Vobiz start event", () => {
    assert.doesNotMatch(src, /firstDefinedString\(msg, \["token", "session_token"\]\)/);
    assert.doesNotMatch(src, /optionalToken/);
  });

  test("authorizeMediaSession is called with undefined in the token position, not a Vobiz-supplied value", () => {
    assert.match(src, /authorizeMediaSession\("vobiz", callId, undefined\)/);
  });

  test("the mandatory callId -> call_logs authorization is unchanged: callId is still required, auth.ok is still checked, and authorizeMediaSession is still the one shared module used (never an inline copy)", () => {
    assert.match(src, /if \(!callId\) return reject\("Missing callId on start event"\);/);
    assert.match(src, /const auth = await authorizeMediaSession\(/);
    assert.match(src, /if \(!auth\.ok\) return reject\(auth\.reason\);/);
    assert.match(
      src,
      /import \{ authorizeMediaSession, maskCallSid \} from "\.\/media-session-authorization\.server\.ts";/,
    );
  });

  test("the entitlement/claim check (duplicate-session rejection) is unchanged", () => {
    assert.match(src, /if \(!claimVobizMediaSession\(callId\)\)/);
  });

  test("never imports verifyMediaSessionToken or mintMediaSessionToken — Vobiz has no media-session-token mechanism, unlike Exotel's (the fix's own explanatory comment names them, which is expected)", () => {
    assert.doesNotMatch(src, /import\s*\{[^}]*verifyMediaSessionToken/);
    assert.doesNotMatch(src, /import\s*\{[^}]*mintMediaSessionToken/);
    assert.doesNotMatch(src, /from\s*"\.\/media-session-token/);
  });
});

describe("vobiz-media-route.server.ts: nested start-event shape fix (production incident: 'Missing callId on start event' rejected every real Vobiz call — callId/streamId are nested under start.callId/start.streamId, the confirmed real Plivo-protocol shape, not flat)", () => {
  test("checks for a nested 'start' sub-object before falling back to flat top-level keys", () => {
    assert.match(
      src,
      /const startData =\s*\n\s*typeof msg\["start"\] === "object" && msg\["start"\] !== null/,
    );
    assert.match(
      src,
      /\(startData && firstDefinedString\(startData, \["callId", "call_id", "CallId", "CallUUID"\]\)\) \?\?/,
    );
    assert.match(
      src,
      /\(startData && firstDefinedString\(startData, \["streamId", "stream_id", "StreamId"\]\)\) \?\?/,
    );
  });

  test("the flat top-level lookup is kept as a fallback, not removed — never weakens what used to work", () => {
    assert.match(src, /firstDefinedString\(msg, \["callId", "call_id", "CallId", "CallUUID"\]\)/);
    assert.match(src, /firstDefinedString\(msg, \["streamId", "stream_id", "StreamId"\]\)/);
  });

  test("the 'Missing callId on start event' rejection is still reached when neither nested nor flat callId is present — the check is widened, never dropped", () => {
    assert.match(src, /if \(!callId\) return reject\("Missing callId on start event"\);/);
  });

  test("logs a start_event_shape diagnostic with field NAMES only (topLevelKeys, nestedStartKeys) — never the raw message, never Object.values", () => {
    const idx = src.indexOf('console.info("vobiz_media_route:start_event_shape"');
    assert.ok(idx > -1, "expected a start_event_shape diagnostic log");
    const block = src.slice(idx, src.indexOf("});", idx));
    assert.match(block, /topLevelKeys: Object\.keys\(msg\)/);
    assert.match(block, /nestedStartKeys: startData \? Object\.keys\(startData\) : null/);
    assert.doesNotMatch(block, /Object\.values/);
    // Only the Object.keys(...) calls above may reference msg/startData
    // inside this log block — nothing else, so no raw field value can leak.
    assert.equal((block.match(/\bmsg\b/g) ?? []).length, 1);
    assert.equal((block.match(/\bstartData\b/g) ?? []).length, 2);
  });
});
