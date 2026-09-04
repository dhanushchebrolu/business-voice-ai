import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimMediaSession,
  registerMediaBridge,
  awaitMediaBridge,
  releaseMediaSession,
} from "./exotel-media-registry.server.ts";
import type { AudioMediaBridge } from "./audio-bridge.ts";

function fakeBridge(): AudioMediaBridge {
  return {
    inboundFormat: { encoding: "linear16", sampleRateHz: 8000 },
    outboundFormat: { encoding: "linear16", sampleRateHz: 8000 },
    onInboundFrame: () => {},
    sendOutboundFrame: () => {},
    clearOutboundBuffer: () => {},
    onClose: () => {},
    close: () => {},
  };
}

test("claimMediaSession: second claim for the same call is rejected (spec §18 duplicate-connection protection)", () => {
  const id = `call-${crypto.randomUUID()}`;
  assert.equal(claimMediaSession(id), true);
  assert.equal(claimMediaSession(id), false);
  releaseMediaSession(id);
});

test("claimMediaSession: released session can be claimed again", () => {
  const id = `call-${crypto.randomUUID()}`;
  assert.equal(claimMediaSession(id), true);
  releaseMediaSession(id);
  assert.equal(claimMediaSession(id), true);
  releaseMediaSession(id);
});

test("awaitMediaBridge resolves once registerMediaBridge is called for the same id", async () => {
  const id = `call-${crypto.randomUUID()}`;
  const bridge = fakeBridge();
  const waiter = awaitMediaBridge(id, 2000);
  registerMediaBridge(id, bridge);
  const resolved = await waiter;
  assert.equal(resolved, bridge);
});

test("awaitMediaBridge resolves immediately if the bridge already arrived first", async () => {
  const id = `call-${crypto.randomUUID()}`;
  const bridge = fakeBridge();
  registerMediaBridge(id, bridge);
  const resolved = await awaitMediaBridge(id, 2000);
  assert.equal(resolved, bridge);
});

test("awaitMediaBridge times out to null if nothing ever registers", async () => {
  const id = `call-${crypto.randomUUID()}`;
  const resolved = await awaitMediaBridge(id, 50);
  assert.equal(resolved, null);
});
