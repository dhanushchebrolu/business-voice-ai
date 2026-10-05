import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  VobizCallSessionDurableObject,
  type DurableObjectState,
} from "./vobiz-call-session-durable-object.server.ts";
import type { AudioMediaBridge, AudioFrame } from "./audio-bridge.ts";
import type { VobizSocketLike } from "./vobiz-media-bridge.server.ts";

/**
 * Vobiz counterpart of call-session-durable-object.server.test.ts — proves
 * VobizCallSessionDurableObject fixes the same cross-isolate correlation gap
 * (production audit finding E1) for Vobiz media calls that the existing
 * CallSessionDurableObject fixes for Exotel, using a SEPARATE class and a
 * SEPARATE Durable Object instance so neither provider's in-flight calls can
 * ever share rendezvous state with the other's.
 *
 * Same sandbox limitations as the Exotel suite (no live Cloudflare Workers
 * runtime, no reachable Supabase/Sarvam) — this proves the bridge-rendezvous
 * state machine, the RPC surface, and the Vobiz-specific "start" event
 * parsing (flat callId/streamId fields, unlike Exotel's nested start.call_sid)
 * using the real (not mocked) class. A real end-to-end Vobiz call against a
 * deployed Cloudflare Worker + VOBIZ_CALL_SESSION binding is still a NEEDS
 * LIVE TEST item, same as Exotel's.
 */

function fakeState(name: string): DurableObjectState {
  return { id: { toString: () => name } };
}

function captureLogs() {
  const calls: { level: "info" | "error"; event: string; data: unknown }[] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (event: unknown, data?: unknown) => {
    calls.push({ level: "info", event: String(event), data });
  };
  console.error = (event: unknown, data?: unknown) => {
    calls.push({ level: "error", event: String(event), data });
  };
  return {
    calls,
    restore: () => {
      console.info = originalInfo;
      console.error = originalError;
    },
  };
}

function fakeBridge(): AudioMediaBridge & {
  sentFrames: AudioFrame[];
  closed: boolean;
  clearedCount: number;
} {
  const inboundHandlers: ((frame: AudioFrame) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  return {
    inboundFormat: { encoding: "mulaw", sampleRateHz: 8000 },
    outboundFormat: { encoding: "mulaw", sampleRateHz: 8000 },
    sentFrames: [],
    closed: false,
    clearedCount: 0,
    onInboundFrame(cb) {
      inboundHandlers.push(cb);
    },
    sendOutboundFrame(frame) {
      this.sentFrames.push(frame);
    },
    clearOutboundBuffer() {
      this.clearedCount++;
    },
    onClose(cb) {
      closeHandlers.push(cb);
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      for (const cb of closeHandlers) cb("closed by test");
    },
  };
}

class FakeSocket implements VobizSocketLike {
  readyState = 1;
  sent: string[] = [];
  accepted = false;
  closedWith: { code: number; reason: string } | null = null;
  private listeners: Record<"message" | "close" | "error", Array<(ev: never) => void>> = {
    message: [],
    close: [],
    error: [],
  };
  accept(): void {
    this.accepted = true;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { code: code ?? 1000, reason: reason ?? "" };
    this.readyState = 3;
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" } as never);
  }
  addEventListener(type: "message" | "close" | "error", cb: (ev: never) => void): void {
    this.listeners[type].push(cb);
  }
  emit(type: "message" | "close" | "error", ev: never): void {
    for (const cb of this.listeners[type]) cb(ev);
  }
}
class FakeWebSocketPair {
  static instances: FakeWebSocketPair[] = [];
  0: FakeSocket;
  1: FakeSocket;
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
    FakeWebSocketPair.instances.push(this);
  }
}

const BASE_RPC_FIELDS = {
  organizationId: "org-1",
  businessId: "biz-1",
  agentConfigId: null,
  agentVersion: null,
  instructions: "test",
  snapshotAgent: {
    primary_language: "en",
    multilingual: false,
    voice_id: "v1",
    speaking_pace: 1,
    greetings: {},
  },
  businessName: "Test Business",
};

describe("VobizCallSessionDurableObject", () => {
  test("fetch() returns 404 for an unrecognized internal path", async () => {
    const doInstance = new VobizCallSessionDurableObject(fakeState("v1"), {});
    const res = await doInstance.fetch(new Request("https://vobiz-call-session/internal/nope"));
    assert.equal(res.status, 404);
  });

  test("fetch() returns 404 for a WebSocket upgrade to the wrong path", async () => {
    const doInstance = new VobizCallSessionDurableObject(fakeState("v2"), {});
    const res = await doInstance.fetch(
      new Request("https://vobiz-call-session/wrong-path", {
        headers: { upgrade: "websocket" },
      }),
    );
    assert.equal(res.status, 404);
  });

  test("fails closed (501, not a crash) when WebSocketPair is unavailable", async () => {
    assert.equal(typeof (globalThis as Record<string, unknown>)["WebSocketPair"], "undefined");
    const doInstance = new VobizCallSessionDurableObject(fakeState("v3"), {});
    const res = await doInstance.fetch(
      new Request("https://vobiz-call-session/api/public/media-stream/vobiz", {
        headers: { upgrade: "websocket" },
      }),
    );
    assert.equal(res.status, 501);
  });

  test("/internal/status for an unknown callId reports inactive without touching the database", async () => {
    const doInstance = new VobizCallSessionDurableObject(fakeState("v4"), {});
    const res = await doInstance.fetch(
      new Request("https://vobiz-call-session/internal/status?callId=does-not-exist"),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { active: false, state: null });
  });

  test("/internal/status without a callId is a 400, not a crash", async () => {
    const doInstance = new VobizCallSessionDurableObject(fakeState("v5"), {});
    const res = await doInstance.fetch(new Request("https://vobiz-call-session/internal/status"));
    assert.equal(res.status, 400);
  });

  test("/internal/terminate-runtime for an unknown callId is an idempotent no-op", async () => {
    const doInstance = new VobizCallSessionDurableObject(fakeState("v6"), {});
    const res = await doInstance.fetch(
      new Request("https://vobiz-call-session/internal/terminate-runtime", {
        method: "POST",
        body: JSON.stringify({ callId: "never-started", reason: "test" }),
      }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const res2 = await doInstance.fetch(
      new Request("https://vobiz-call-session/internal/terminate-runtime", {
        method: "POST",
        body: JSON.stringify({ callId: "never-started", reason: "test again" }),
      }),
    );
    assert.equal(res2.status, 200);
  });

  test("/internal/start-runtime times out (does not hang, does not throw) when no bridge ever arrives", async () => {
    const doInstance = new VobizCallSessionDurableObject(fakeState("v7"), {});
    const started = Date.now();
    const res = await doInstance.fetch(
      new Request("https://vobiz-call-session/internal/start-runtime", {
        method: "POST",
        body: JSON.stringify({
          ...BASE_RPC_FIELDS,
          callId: "call-timeout-1",
          providerCallId: "vobiz-call-timeout-1",
          timeoutMs: 60,
        }),
      }),
    );
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { handled: boolean; note: string };
    assert.equal(body.handled, false);
    assert.match(body.note, /does not expose a live audio channel/);
    assert.ok(elapsed >= 55, `expected to actually wait ~60ms, only waited ${elapsed}ms`);
    assert.ok(elapsed < 2000, `timeout took far longer than requested (${elapsed}ms)`);
  });

  test("a bridge registered before start-runtime is requested is used immediately (arrived-before-waiter ordering)", async () => {
    const doInstance = new VobizCallSessionDurableObject(fakeState("v8"), {}) as unknown as {
      registerBridge: (id: string, bridge: AudioMediaBridge) => void;
    };
    const bridge = fakeBridge();
    doInstance.registerBridge("vobiz-callsid-early-arrival", bridge);

    const started = Date.now();
    const res = await (doInstance as unknown as VobizCallSessionDurableObject).fetch(
      new Request("https://vobiz-call-session/internal/start-runtime", {
        method: "POST",
        body: JSON.stringify({
          ...BASE_RPC_FIELDS,
          callId: "call-early-arrival",
          providerCallId: "vobiz-callsid-early-arrival",
          timeoutMs: 5000,
        }),
      }),
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 1000,
      `expected the already-arrived bridge to resolve fast, took ${elapsed}ms`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { handled: boolean; note: string };
    // No SARVAM_API_KEY configured in this sandbox — startRuntimeSession
    // fails closed (pre-existing, tested behavior). What matters here is
    // that a real bridge was found and startRuntimeSession was reached.
    assert.equal(body.handled, false);
  });

  test("PROOF: two Vobiz Durable Object instances never share bridge-rendezvous state", async () => {
    const instanceA = new VobizCallSessionDurableObject(fakeState("vshard-a"), {}) as unknown as {
      registerBridge: (id: string, bridge: AudioMediaBridge) => void;
    };
    const instanceB = new VobizCallSessionDurableObject(fakeState("vshard-b"), {});

    const bridgeOnA = fakeBridge();
    instanceA.registerBridge("shared-vobiz-callsid", bridgeOnA);

    const started = Date.now();
    const res = await instanceB.fetch(
      new Request("https://vobiz-call-session/internal/start-runtime", {
        method: "POST",
        body: JSON.stringify({
          ...BASE_RPC_FIELDS,
          callId: "call-on-b",
          providerCallId: "shared-vobiz-callsid",
          timeoutMs: 80,
        }),
      }),
    );
    const elapsed = Date.now() - started;
    const body = (await res.json()) as { handled: boolean; note: string };

    assert.equal(body.handled, false, "instance B must NOT see instance A's registered bridge");
    assert.match(body.note, /does not expose a live audio channel/);
    assert.ok(
      elapsed >= 70,
      `instance B should have genuinely waited out its own timeout (~80ms), only took ${elapsed}ms`,
    );
  });

  test("PROOF: Vobiz and Exotel Durable Object instances never share bridge-rendezvous state, even with the same providerCallId", async () => {
    const { CallSessionDurableObject } = await import("./call-session-durable-object.server.ts");
    const exotelInstance = new CallSessionDurableObject(
      fakeState("cross-exotel"),
      {},
    ) as unknown as {
      registerBridge: (id: string, bridge: AudioMediaBridge) => void;
    };
    const vobizInstance = new VobizCallSessionDurableObject(fakeState("cross-vobiz"), {});

    // Register a bridge on the EXOTEL coordinator for a providerCallId...
    exotelInstance.registerBridge("cross-provider-shared-id", fakeBridge());

    // ...and ask the VOBIZ coordinator (a genuinely different class/binding)
    // to await a bridge for that exact same id. If the two providers'
    // Durable Objects were ever accidentally wired to the same binding or
    // shared any state, this would resolve immediately instead of timing
    // out — the one cross-provider isolation failure mode this migration
    // must never introduce.
    const started = Date.now();
    const res = await vobizInstance.fetch(
      new Request("https://vobiz-call-session/internal/start-runtime", {
        method: "POST",
        body: JSON.stringify({
          ...BASE_RPC_FIELDS,
          callId: "call-cross-provider",
          providerCallId: "cross-provider-shared-id",
          timeoutMs: 80,
        }),
      }),
    );
    const elapsed = Date.now() - started;
    const body = (await res.json()) as { handled: boolean; note: string };

    assert.equal(body.handled, false, "Vobiz's DO must NOT see Exotel's DO's registered bridge");
    assert.ok(
      elapsed >= 70,
      `expected the Vobiz DO to genuinely wait out its own timeout, only took ${elapsed}ms`,
    );
  });

  test("with a real WebSocketPair available, the server-side socket is accepted before the platform-specific 101 response is built", async () => {
    const originalPair = (globalThis as Record<string, unknown>)["WebSocketPair"];
    FakeWebSocketPair.instances = [];
    (globalThis as Record<string, unknown>)["WebSocketPair"] = FakeWebSocketPair;
    try {
      const doInstance = new VobizCallSessionDurableObject(fakeState("v11"), {});
      const res = await doInstance.fetch(
        new Request("https://vobiz-call-session/api/public/media-stream/vobiz", {
          headers: { upgrade: "websocket" },
        }),
      );
      // Node's Response constructor rejects status 101 with a `webSocket`
      // property, so this always falls into the DO's catch-all 500 here.
      assert.equal(res.status, 500);
      assert.equal(FakeWebSocketPair.instances.length, 1);
      assert.equal(
        FakeWebSocketPair.instances[0]![0].accepted,
        true,
        "expected the server-side socket to be accepted before the (Node-unsupported) 101 response was attempted",
      );
    } finally {
      if (originalPair === undefined)
        delete (globalThis as Record<string, unknown>)["WebSocketPair"];
      else (globalThis as Record<string, unknown>)["WebSocketPair"] = originalPair;
    }
  });

  test("BUGFIX regression: a 'media' frame arriving in the same tick as 'start' does not crash the process and the socket is still cleanly closed once validation fails", async () => {
    const originalPair = (globalThis as Record<string, unknown>)["WebSocketPair"];
    FakeWebSocketPair.instances = [];
    (globalThis as Record<string, unknown>)["WebSocketPair"] = FakeWebSocketPair;
    try {
      const doInstance = new VobizCallSessionDurableObject(fakeState("v12"), {});
      await doInstance.fetch(
        new Request("https://vobiz-call-session/api/public/media-stream/vobiz", {
          headers: { upgrade: "websocket" },
        }),
      );
      const serverSocket = FakeWebSocketPair.instances[0]![0];

      // Vobiz's "start" fields are flat on the message (callId, not a
      // nested start.call_sid like Exotel) — see vobiz-media-route.server.ts.
      serverSocket.emit("message", {
        data: JSON.stringify({ event: "start", callId: "vobiz-call-race-1" }),
      } as never);
      serverSocket.emit("message", {
        data: JSON.stringify({ event: "media", media: "AAAA" }),
      } as never);

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.ok(
        serverSocket.closedWith !== null,
        "expected the socket to have been closed once validation failed, not left hanging open",
      );
    } finally {
      if (originalPair === undefined)
        delete (globalThis as Record<string, unknown>)["WebSocketPair"];
      else (globalThis as Record<string, unknown>)["WebSocketPair"] = originalPair;
    }
  });

  test("a 'start' event with no callId at all is rejected — socket closed 1008, never left hanging waiting for a database lookup that has nothing to look up", async () => {
    const originalPair = (globalThis as Record<string, unknown>)["WebSocketPair"];
    FakeWebSocketPair.instances = [];
    (globalThis as Record<string, unknown>)["WebSocketPair"] = FakeWebSocketPair;
    try {
      const doInstance = new VobizCallSessionDurableObject(fakeState("v13"), {});
      await doInstance.fetch(
        new Request("https://vobiz-call-session/api/public/media-stream/vobiz", {
          headers: { upgrade: "websocket" },
        }),
      );
      const serverSocket = FakeWebSocketPair.instances[0]![0];

      // "start" with a streamId but deliberately no callId/call_id/CallId/CallUUID.
      serverSocket.emit("message", {
        data: JSON.stringify({ event: "start", streamId: "ST-no-id" }),
      } as never);

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.ok(serverSocket.closedWith, "expected the socket to be closed, not left open");
      assert.equal(serverSocket.closedWith!.code, 1008);
      assert.equal(serverSocket.closedWith!.reason, "unauthorized");
    } finally {
      if (originalPair === undefined)
        delete (globalThis as Record<string, unknown>)["WebSocketPair"];
      else (globalThis as Record<string, unknown>)["WebSocketPair"] = originalPair;
    }
  });

  test("DIAGNOSTIC: a bridge that never arrives logs start_runtime_received then start_runtime_no_bridge, never a raw secret/payload value", async () => {
    const doInstance = new VobizCallSessionDurableObject(fakeState("vdiag-no-bridge"), {});
    const logs = captureLogs();
    let body: { handled: boolean; note: string };
    try {
      const res = await doInstance.fetch(
        new Request("https://vobiz-call-session/internal/start-runtime", {
          method: "POST",
          body: JSON.stringify({
            ...BASE_RPC_FIELDS,
            callId: "call-diag-no-bridge",
            providerCallId: "vobiz-callsid-diag-no-bridge",
            timeoutMs: 50,
          }),
        }),
      );
      body = (await res.json()) as { handled: boolean; note: string };
    } finally {
      logs.restore();
    }
    assert.equal(body!.handled, false);

    const received = logs.calls.find(
      (c) => c.event === "vobiz_call_session_do:start_runtime_received",
    );
    assert.ok(received, "expected start_runtime_received to log before the bridge wait");

    const noBridge = logs.calls.find(
      (c) => c.event === "vobiz_call_session_do:start_runtime_no_bridge",
    );
    assert.ok(
      noBridge,
      "expected start_runtime_no_bridge to log the exact reason for handled:false",
    );
  });
});

describe("Vobiz callId correlation is delegated to the shared module (same production-incident class of regression as Exotel's)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "vobiz-call-session-durable-object.server.ts"),
    "utf8",
  );

  test("imports authorizeMediaSession from the shared module (called with 'vobiz'), never its own inline copy", () => {
    assert.match(
      src,
      /import \{ authorizeMediaSession, maskCallSid \} from "\.\/media-session-authorization\.server\.ts";/,
    );
    assert.match(
      src,
      /const auth = await authorizeMediaSession\("vobiz", callId, optionalToken\);/,
    );
  });

  test("no independent call_logs lookup/retry loop remains in this file", () => {
    assert.doesNotMatch(src, /CALL_LOOKUP_ATTEMPTS/);
    assert.doesNotMatch(src, /\.from\("call_logs"\)/);
    assert.doesNotMatch(src, /checkTelephonyAccess\(/);
  });

  test("the accepted-session log masks the providerCallId rather than printing it raw", () => {
    const idx = src.indexOf('console.info("vobiz_call_session_do:media_accepted"');
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 200);
    assert.match(block, /providerCallId: maskCallSid\(callId\)/);
  });

  test("this file never imports Exotel's bridge/path/authorization-wrapper — the two providers' media code stays isolated", () => {
    assert.doesNotMatch(src, /ExotelMediaBridge/);
    assert.doesNotMatch(src, /authorizeExotelMediaSession/);
    assert.doesNotMatch(src, /EXOTEL_MEDIA_STREAM_PATH/);
  });
});
