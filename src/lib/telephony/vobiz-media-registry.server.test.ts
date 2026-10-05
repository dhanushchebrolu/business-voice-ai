import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimVobizMediaSession,
  registerVobizMediaBridge,
  awaitVobizMediaBridge,
  releaseVobizMediaSession,
} from "./vobiz-media-registry.server.ts";
import type { AudioMediaBridge } from "./audio-bridge.ts";

function fakeBridge(): AudioMediaBridge {
  return {
    inboundFormat: { encoding: "mulaw", sampleRateHz: 8000 },
    outboundFormat: { encoding: "mulaw", sampleRateHz: 8000 },
    onInboundFrame: () => {},
    sendOutboundFrame: () => {},
    clearOutboundBuffer: () => {},
    onClose: () => {},
    close: () => {},
  };
}

test("claimVobizMediaSession: second claim for the same call is rejected (duplicate-connection protection)", () => {
  const id = `call-${crypto.randomUUID()}`;
  assert.equal(claimVobizMediaSession(id), true);
  assert.equal(claimVobizMediaSession(id), false);
  releaseVobizMediaSession(id);
});

test("claimVobizMediaSession: released session can be claimed again", () => {
  const id = `call-${crypto.randomUUID()}`;
  assert.equal(claimVobizMediaSession(id), true);
  releaseVobizMediaSession(id);
  assert.equal(claimVobizMediaSession(id), true);
  releaseVobizMediaSession(id);
});

test("awaitVobizMediaBridge resolves once registerVobizMediaBridge is called for the same id", async () => {
  const id = `call-${crypto.randomUUID()}`;
  const bridge = fakeBridge();
  const waiter = awaitVobizMediaBridge(id, 2000);
  registerVobizMediaBridge(id, bridge);
  const resolved = await waiter;
  assert.equal(resolved, bridge);
});

test("awaitVobizMediaBridge resolves immediately if the bridge already arrived first", async () => {
  const id = `call-${crypto.randomUUID()}`;
  const bridge = fakeBridge();
  registerVobizMediaBridge(id, bridge);
  const resolved = await awaitVobizMediaBridge(id, 2000);
  assert.equal(resolved, bridge);
});

test("awaitVobizMediaBridge times out to null if nothing ever registers", async () => {
  const id = `call-${crypto.randomUUID()}`;
  const resolved = await awaitVobizMediaBridge(id, 50);
  assert.equal(resolved, null);
});

test("Vobiz and Exotel registries are independent modules — a Vobiz claim does not collide with an Exotel one for the same id string", async () => {
  const { claimMediaSession, releaseMediaSession } =
    await import("./exotel-media-registry.server.ts");
  const id = `shared-id-${crypto.randomUUID()}`;
  assert.equal(claimVobizMediaSession(id), true);
  assert.equal(claimMediaSession(id), true);
  releaseVobizMediaSession(id);
  releaseMediaSession(id);
});
