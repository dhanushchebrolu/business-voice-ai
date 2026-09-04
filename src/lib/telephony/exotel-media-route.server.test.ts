import { test } from "node:test";
import assert from "node:assert/strict";
import { handleExotelMediaUpgrade } from "./exotel-media-route.server.ts";

test("returns null (pass-through to the normal app router) for any non-media-stream path", async () => {
  const req = new Request("https://vaani.app/api/public/webhooks/telephony?provider=exotel", {
    headers: { upgrade: "websocket" },
  });
  const res = await handleExotelMediaUpgrade(req);
  assert.equal(res, null);
});

test("rejects a non-upgrade request to the media-stream path", async () => {
  const req = new Request("https://vaani.app/api/public/media-stream/exotel");
  const res = await handleExotelMediaUpgrade(req);
  assert.ok(res);
  assert.equal(res!.status, 400);
});

test("fails closed (501, not a crash) when the Cloudflare WebSocketPair global is unavailable — the real state of this Node test environment, not a mock", async () => {
  assert.equal(typeof (globalThis as Record<string, unknown>)["WebSocketPair"], "undefined");
  const req = new Request("https://vaani.app/api/public/media-stream/exotel", {
    headers: { upgrade: "websocket" },
  });
  const res = await handleExotelMediaUpgrade(req);
  assert.ok(res);
  assert.equal(res!.status, 501);
});
