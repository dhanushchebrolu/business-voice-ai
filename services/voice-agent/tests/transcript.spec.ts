/**
 * G3: the agent reports the conversation to klyro in the dashboard's
 * call_logs.transcript shape (the Worker runtime's ConversationTurn), from
 * the LiveKit session history: speech only, in order, timestamped, within
 * klyro's session-end limit, sent on both end paths.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_TRANSCRIPT_TURNS,
  TRANSCRIPT_BUDGET_BYTES,
  reportEnd,
  transcriptFrom,
  type HistoryItem,
} from "../src/agent/call.ts";
import { newConversation } from "../src/conversation/state.ts";
import { CallTelemetry } from "../src/runtime/telemetry.ts";
import type { KlyroClient } from "../src/backend/klyro-client.ts";
import { TranscriptCheckpointer } from "../src/runtime/transcript-checkpoint.ts";

const T0 = Date.UTC(2026, 10, 7, 5, 0, 0);
const msg = (role: string, text: string, i: number): HistoryItem => ({
  type: "message",
  role,
  textContent: text,
  createdAt: T0 + i * 1000,
});

describe("G3: transcriptFrom (what the dashboard will show)", () => {
  test("caller and agent speech only, in order, with ISO times", () => {
    const t = transcriptFrom([
      msg("system", "You are the receptionist. SECRET INSTRUCTIONS", 0),
      msg("assistant", "Hi Dhanush! Thanks for calling Smile Dental.", 1),
      msg("user", "టీత్ క్లీనింగ్", 2),
      {
        type: "function_call",
        role: undefined,
        textContent: '{"name":"check_availability"}',
        createdAt: T0 + 3000,
      },
      { type: "function_call_output", textContent: "SLOTS: 13:30", createdAt: T0 + 4000 },
      msg("developer", "NEXT STEP: ask the service", 5),
      msg("assistant", "8 నవంబర్, 1:30 PM ఖాళీగా ఉంది.", 6),
      msg("user", "   ", 7),
    ]);
    assert.deepEqual(
      t.map((x) => [x.role, x.text]),
      [
        ["assistant", "Hi Dhanush! Thanks for calling Smile Dental."],
        ["user", "టీత్ క్లీనింగ్"],
        ["assistant", "8 నవంబర్, 1:30 PM ఖాళీగా ఉంది."],
      ],
    );
    assert.equal(t[0]!.at, new Date(T0 + 1000).toISOString());
    assert.doesNotMatch(JSON.stringify(t), /SECRET|NEXT STEP|check_availability|SLOTS/);
  });
  test("createdAt in seconds or milliseconds gives the same time", () => {
    const [a] = transcriptFrom([
      { type: "message", role: "user", textContent: "x", createdAt: T0 / 1000 },
    ]);
    const [b] = transcriptFrom([
      { type: "message", role: "user", textContent: "x", createdAt: T0 },
    ]);
    assert.equal(a!.at, b!.at);
  });
  test("a very long call fits klyro's limit by shortening turns, never dropping them", () => {
    const items = Array.from({ length: 360 }, (_, i) =>
      msg(i % 2 ? "user" : "assistant", "పళ్ళు క్లీన్ చేసుకోవాలి అనుకుంటున్నాను ".repeat(40), i),
    );
    const t = transcriptFrom(items);
    assert.equal(t.length, 360, "every turn kept");
    assert.ok(new TextEncoder().encode(JSON.stringify(t)).length <= TRANSCRIPT_BUDGET_BYTES);
    assert.ok(t.every((x) => x.text.length > 0));
  });
  test("at most MAX_TRANSCRIPT_TURNS turns (klyro's schema limit)", () => {
    const items = Array.from({ length: MAX_TRANSCRIPT_TURNS + 50 }, (_, i) =>
      msg("user", `t${i}`, i),
    );
    assert.equal(transcriptFrom(items).length, MAX_TRANSCRIPT_TURNS);
  });
});

describe("G3: reportEnd sends the transcript and the Worker's summary line", () => {
  function fakeClient() {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const client = {
      post: async (path: string, body: Record<string, unknown>) => (posts.push({ path, body }), {}),
    } as unknown as KlyroClient;
    return { client, posts };
  }
  test("with turns: transcript, '<n> turns · <language>', binding", async () => {
    const { client, posts } = fakeClient();
    const state = newConversation({ callId: "c1", callerId: null, primaryLanguage: "te-IN" });
    const transcript = transcriptFrom([msg("assistant", "నమస్కారం", 0), msg("user", "హలో", 1)]);
    await reportEnd(
      client,
      "c1",
      "caller_hangup",
      state,
      new CallTelemetry({ callId: "c1", sipCallId: "SCL_1", room: "call-1" }),
      { roomName: "call-1", sipCallId: "SCL_1" },
      transcript,
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, "/api/internal/voice-agent/session-end");
    assert.deepEqual(posts[0]!.body["transcript"], transcript);
    assert.equal(posts[0]!.body["summary"], "2 turns · te-IN");
    assert.equal(posts[0]!.body["roomName"], "call-1");
    assert.doesNotMatch(
      String(posts[0]!.body["summary"]),
      /intent=|booking=/,
      "no internal debug text",
    );
  });
  test("a call with no conversation says so", async () => {
    const { client, posts } = fakeClient();
    const state = newConversation({ callId: "c2", callerId: null, primaryLanguage: "en-IN" });
    await reportEnd(
      client,
      "c2",
      "x",
      state,
      new CallTelemetry({ callId: "c2", sipCallId: null, room: "r" }),
      undefined,
      [],
    );
    assert.equal(posts[0]!.body["summary"], "No conversation recorded.");
  });
  test("klyro being down never throws out of reportEnd", async () => {
    const client = {
      post: async () => {
        throw new Error("down");
      },
    } as unknown as KlyroClient;
    const state = newConversation({ callId: "c3", callerId: null, primaryLanguage: "en-IN" });
    await reportEnd(
      client,
      "c3",
      "x",
      state,
      new CallTelemetry({ callId: "c3", sipCallId: null, room: "r" }),
      undefined,
      [],
    );
  });
});

describe("crash safety: TranscriptCheckpointer (throttled, single in flight, retried)", () => {
  function harness(o: { fail?: number; hold?: boolean } = {}) {
    let now = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const turns: { role: "user" | "assistant"; text: string; at: string }[] = [];
    const sent: number[] = [];
    let fail = o.fail ?? 0;
    let release: (() => void) | null = null;
    const cp = new TranscriptCheckpointer({
      snapshot: () => [...turns],
      send: async (t) => {
        sent.push(t.length);
        if (o.hold) await new Promise<void>((r) => (release = r));
        if (fail > 0) {
          fail--;
          throw new Error("klyro down");
        }
      },
      now: () => now,
      setTimer: (fn, ms) => (timers.push({ fn, at: now + ms }), timers.length - 1),
      clearTimer: (i) => {
        timers[i as number] = { fn: () => undefined, at: Infinity };
      },
    });
    const add = (n = 1) => {
      for (let i = 0; i < n; i++)
        turns.push({ role: "user", text: `t${turns.length}`, at: new Date(now).toISOString() });
      cp.notify();
    };
    const advance = async (ms: number) => {
      now += ms;
      for (const t of timers.splice(0)) {
        if (t.at <= now) t.fn();
        else timers.push(t);
      }
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return { cp, add, advance, sent, release: () => release?.(), tick: () => advance(0) };
  }

  test("the first turn is checkpointed at once; then at most one per 15 s with the latest snapshot", async () => {
    const h = harness();
    h.add();
    await h.tick();
    assert.deepEqual(h.sent, [1]);
    h.add(3);
    await h.advance(5_000);
    assert.deepEqual(h.sent, [1], "throttled");
    await h.advance(10_000);
    assert.deepEqual(h.sent, [1, 4], "the trailing flush sends everything new");
  });
  test("no new turns: no write", async () => {
    const h = harness();
    h.add();
    await h.tick();
    await h.advance(60_000);
    h.cp.notify();
    await h.advance(60_000);
    assert.deepEqual(h.sent, [1]);
  });
  test("a failed checkpoint is retried with the newer snapshot; nothing is lost", async () => {
    const h = harness({ fail: 1 });
    h.add(2);
    await h.tick();
    assert.deepEqual(h.sent, [2]);
    h.add();
    await h.advance(15_000);
    assert.deepEqual(h.sent, [2, 3]);
  });
  test("never two in flight; close() waits for the one in flight and stops further sends", async () => {
    const h = harness({ hold: true });
    h.add();
    await h.tick();
    h.add();
    await h.advance(20_000);
    assert.deepEqual(h.sent, [1], "second waits for the first");
    const closing = h.cp.close();
    h.release();
    await closing;
    h.add();
    await h.advance(60_000);
    assert.deepEqual(h.sent, [1], "nothing after close (the final report carries the rest)");
  });
  test("over a 10-minute call with a turn every 3 s, writes stay within the 15 s budget", async () => {
    const h = harness();
    for (let s = 0; s < 600; s += 3) {
      h.add();
      await h.advance(3_000);
    }
    assert.ok(h.sent.length <= 41, `${h.sent.length} writes`);
    assert.equal(h.sent.at(-1), 200, "the last checkpoint has every turn");
    assert.deepEqual(
      [...h.sent].sort((a, b) => a - b),
      h.sent,
      "snapshots only grow",
    );
  });
});
