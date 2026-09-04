import { test } from "node:test";
import assert from "node:assert/strict";

// These tests intentionally run with SARVAM_API_KEY unset (this repository
// has no real Sarvam credentials anywhere — see PHASE_E_FINAL_REPORT.md
// "Real integration test status"). They verify the one thing that IS
// meaningfully testable without live credentials: that a missing key fails
// fast and clearly, before any socket is opened, rather than hanging or
// throwing something unstructured.
test("connectSarvamStt rejects with a structured error when SARVAM_API_KEY is unset", async () => {
  delete process.env["SARVAM_API_KEY"];
  const { connectSarvamStt, SarvamRealtimeError } = await import("./sarvam-realtime.server.ts");
  await assert.rejects(
    () =>
      connectSarvamStt({
        language: "en-IN",
        sampleRateHz: 8000,
        encoding: "mulaw",
        onEvent: () => {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof SarvamRealtimeError);
      assert.equal(err.code, "not_configured");
      return true;
    },
  );
});

test("connectSarvamTts rejects with a structured error when SARVAM_API_KEY is unset", async () => {
  delete process.env["SARVAM_API_KEY"];
  const { connectSarvamTts, SarvamRealtimeError } = await import("./sarvam-realtime.server.ts");
  await assert.rejects(
    () =>
      connectSarvamTts({
        voiceId: "ritu",
        language: "en-IN",
        pace: 1,
        outputCodec: "mulaw",
        outputSampleRateHz: 8000,
        onEvent: () => {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof SarvamRealtimeError);
      assert.equal(err.code, "not_configured");
      return true;
    },
  );
});
