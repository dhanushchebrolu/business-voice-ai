/**
 * Phase 3 speech harness: audio, metrics, client protocols, result
 * validation, plan coverage and reporting. Offline: network disabled for the
 * whole file; Sarvam is the in-process fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  AudioFormatError,
  muLawDecode,
  muLawEncode,
  muLawToWav,
  parseWav,
  pcm16ToWav,
  resample,
  rms,
  tone,
  wavSamples,
} from "../bench/speech/audio.ts";
import {
  SpeechCallError,
  sttRest,
  sttWebSocket,
  ttsHttpStream,
  ttsRest,
  ttsWebSocket,
  type CallContext,
  type Clock,
} from "../bench/speech/clients.ts";
import { main } from "../bench/speech/cli.ts";
import { FakeSarvam } from "../bench/speech/fake-sarvam.ts";
import { FIXTURES, V4_FLASH_VOICES } from "../bench/speech/fixtures.ts";
import { cer, checkEntities, normalize, percentile, wer } from "../bench/speech/metrics.ts";
import { disableNetwork, type NetworkGuard } from "../bench/speech/network.ts";
import {
  buildPlan,
  defaultLimits,
  isTts,
  summarize,
  textOf,
  type PlanItem,
  type SttItem,
  type TtsItem,
} from "../bench/speech/plan.ts";
import { Ledger, type Prices } from "../bench/speech/pricing.ts";
import { buildResults, markdownReport } from "../bench/speech/report.ts";
import { runPlan } from "../bench/speech/runner.ts";
import type { SocketLike, Transport } from "../bench/speech/transport.ts";

const P: Prices = {
  sttPerMinute: 0.49,
  ttsPer1k: { "bulbul:v3": 3, "bulbul:v4-flash": 2 },
  gstRate: 0.18,
};
const clock: Clock = { now: () => performance.now(), sleep: async () => {} };
const PLAN = buildPlan();
const pick = (...ids: string[]): PlanItem[] => ids.map((id) => PLAN.find((i) => i.id === id)!);
const ctxFor = (transport: Transport, timeoutMs = 2000): CallContext => ({
  transport,
  headers: {},
  clock,
  timeoutMs,
  redact: (x) => x,
});
const run = (plan: PlanItem[], transport: Transport) =>
  runPlan(plan, {
    transport,
    ledger: new Ledger(P, defaultLimits(40, PLAN)),
    headers: {},
    clock,
    redact: (x) => x,
    timeoutMs: 2000,
    minIntervalMs: 0,
    retryBackoffMs: 0,
    realtimeStreaming: false,
  });

let guard: NetworkGuard;
before(() => {
  guard = disableNetwork();
});
after(() => guard.restore());

/* ------------------------------------------------------------------ audio */

describe("audio: WAV, mu-law, 8 kHz telephony", () => {
  test("PCM16 WAV round-trips with rate and duration", () => {
    const wav = pcm16ToWav(tone(440, 500, 16000), 16000);
    const info = parseWav(wav);
    assert.deepEqual(
      [info.format, info.sampleRate, info.channels, info.bitsPerSample],
      ["pcm16", 16000, 1, 16],
    );
    assert.equal(info.durationSec, 0.5);
    assert.equal(wavSamples(wav).samples.length, 8000);
  });
  test("mu-law WAV (G.711, format 7) parses and decodes within quantisation error", () => {
    const pcm = tone(300, 200, 8000);
    const wav = muLawToWav(muLawEncode(pcm), 8000);
    const info = parseWav(wav);
    assert.deepEqual([info.format, info.sampleRate, info.bitsPerSample], ["mulaw", 8000, 8]);
    const back = wavSamples(wav).samples;
    let maxErr = 0;
    for (let i = 0; i < pcm.length; i++) maxErr = Math.max(maxErr, Math.abs(pcm[i]! - back[i]!));
    assert.ok(maxErr < 8000 * 0.04, `max error ${maxErr}`);
    assert.equal(muLawDecode(muLawEncode(new Int16Array([0])))[0], 0);
  });
  test("malformed audio is rejected, not guessed", () => {
    const good = pcm16ToWav(tone(440, 100, 16000), 16000);
    assert.throws(() => parseWav(new Uint8Array(10)), AudioFormatError);
    const notRiff = good.slice();
    notRiff.set([0x58, 0x58, 0x58, 0x58], 0);
    assert.throws(() => parseWav(notRiff), /not a RIFF/);
    const bits24 = Buffer.from(good);
    bits24.writeUInt16LE(24, 34);
    assert.throws(() => parseWav(bits24), /16-bit/);
    const adpcm = Buffer.from(good);
    adpcm.writeUInt16LE(2, 20);
    assert.throws(() => parseWav(adpcm), /unsupported WAV format/);
  });
  test("16 kHz -> 8 kHz keeps duration and pitch (telephony audio)", () => {
    const src = tone(400, 1000, 16000);
    const out = resample(src, 16000, 8000);
    assert.equal(out.length, 8000);
    const crossings = (s: Int16Array) =>
      s.reduce((n, v, i) => n + (i && s[i - 1]! < 0 !== v < 0 ? 1 : 0), 0);
    assert.ok(Math.abs(crossings(out) - crossings(src)) <= 4, "same frequency");
    assert.ok(rms(out) > 0.6 * rms(src), "not attenuated to nothing");
  });
});

/* ------------------------------------------------------------------ metrics */

describe("metrics: normalization, error rates and entities", () => {
  test("native digits, digit groups and punctuation normalize", () => {
    assert.equal(normalize("मेरा नंबर १२३४५ ६७८९०।"), "मेरा नंबर 1234567890");
    assert.equal(normalize("నా నంబర్ ౧౨౩౪౫ 67890."), "నా నంబర్ 1234567890");
    assert.equal(normalize("Call 12,345-678"), "call 12345678");
  });
  test("CER/WER: identical is 0; Indic syllables count as one unit", () => {
    assert.equal(cer("నమస్కారం", "నమస్కారం"), 0);
    assert.ok(cer("నమస్కారం", "నమస్కార") > 0 && cer("నమస్కారం", "నమస్కార") < 0.5);
    assert.equal(wer("book a cleaning", "book cleaning"), 1 / 3);
  });
  test("entities: grouped phone digits, time formats, words, and a real miss", () => {
    const f = FIXTURES.find((x) => x.id === "hi-mix-phone-grouped")!;
    assert.ok(checkEntities(f.entities, "मेरा phone number 12345 67890 है").every((e) => e.ok));
    assert.ok(checkEntities(f.entities, "मेरा phone number 1234 567 890 है").every((e) => e.ok));
    assert.equal(
      checkEntities(f.entities, "मेरा phone number 123456789 है")[0]!.ok,
      false,
      "a dropped digit fails",
    );
    const t = FIXTURES.find((x) => x.id === "hi-appointment")!;
    for (const said of ["कल शाम 4:30 बजे क्लीनिंग", "कल शाम 4.30 बजे", "कल शाम साढ़े चार बजे"])
      assert.equal(checkEntities(t.entities, said)[0]!.ok, true, said);
    assert.equal(checkEntities(t.entities, "कल शाम 5:30 बजे")[0]!.ok, false);
  });
  test("percentile ignores missing values", () => {
    assert.equal(percentile([5, -1, 1, 3], 0.5), 3);
    assert.equal(percentile([], 0.5), null);
  });
});

/* ------------------------------------------------------------------ client protocols */

describe("clients speak the documented protocols", () => {
  test("TTS REST: documented body fields; one base64 WAV back", async () => {
    const fake = new FakeSarvam();
    const r = await ttsRest(ctxFor(fake), {
      model: "bulbul:v3",
      speaker: "priya",
      languageCode: "te-IN",
      text: "నమస్కారం",
      sampleRate: 8000,
      codec: "wav",
    });
    assert.equal(parseWav(r.audio).sampleRate, 8000);
    assert.deepEqual(
      { ...fake.calls[0]!, headerNames: undefined },
      {
        endpoint: "tts",
        model: "bulbul:v3",
        speaker: "priya",
        mode: null,
        language: "te-IN",
        sampleRate: 8000,
        codec: "wav",
        headerNames: undefined,
      },
    );
  });
  test("TTS REST: a response without exactly one audio is a protocol error; HTTP errors carry Sarvam's error code", async () => {
    const malformed = new FakeSarvam({
      faults: [{ when: () => true, respond: { malformed: true } }],
    });
    await assert.rejects(
      ttsRest(ctxFor(malformed), {
        model: "bulbul:v3",
        speaker: "priya",
        languageCode: "en-IN",
        text: "hi",
        sampleRate: 16000,
        codec: "wav",
      }),
      (e: SpeechCallError) => e.kind === "protocol",
    );
    const bad = new FakeSarvam({
      faults: [
        {
          when: () => true,
          respond: {
            status: 422,
            body: { error: { code: "invalid_request_error", message: "speaker not valid" } },
          },
        },
      ],
    });
    await assert.rejects(
      ttsRest(ctxFor(bad), {
        model: "bulbul:v3",
        speaker: "x",
        languageCode: "en-IN",
        text: "hi",
        sampleRate: 16000,
        codec: "wav",
      }),
      (e: SpeechCallError) =>
        e.kind === "http" &&
        e.status === 422 &&
        e.code === "invalid_request_error" &&
        /speaker not valid/.test(e.message),
    );
  });
  test("TTS HTTP stream and WebSocket: audio arrives in chunks, with first-byte / first-audio latency", async () => {
    const fake = new FakeSarvam();
    const req = {
      model: "bulbul:v3",
      speaker: "priya",
      languageCode: "hi-IN",
      text: "नमस्ते",
      sampleRate: 16000,
      codec: "linear16" as const,
    };
    const s = await ttsHttpStream(ctxFor(fake), req);
    assert.ok(s.audio.length > 0 && s.ms.firstByte >= 0);
    const w = await ttsWebSocket(ctxFor(fake), req);
    assert.ok(w.audio.length > 0 && w.ms.firstAudio >= 0);
    assert.deepEqual(
      [
        fake.calls[1]!.endpoint,
        fake.calls[1]!.model,
        fake.calls[1]!.speaker,
        fake.calls[1]!.language,
      ],
      ["tts-ws", "bulbul:v3", "priya", "hi-IN"],
    );
  });
  test("STT REST: multipart with model, mode and language; STT WebSocket: documented query parameters", async () => {
    const fake = new FakeSarvam();
    const tts = await ttsRest(ctxFor(fake), {
      model: "bulbul:v3",
      speaker: "priya",
      languageCode: "en-IN",
      text: "Yes, that works for me.",
      sampleRate: 16000,
      codec: "wav",
    });
    const r = await sttRest(ctxFor(fake), {
      model: "saaras:v4",
      mode: "codemix",
      languageCode: "unknown",
      audio: tts.audio,
      filename: "a.wav",
    });
    assert.equal(r.transcript, "Yes, that works for me.");
    assert.deepEqual(
      [fake.calls[1]!.model, fake.calls[1]!.mode, fake.calls[1]!.language],
      ["saaras:v4", "codemix", "unknown"],
    );
    const pcm = wavSamples(tts.audio).samples;
    const ws = await sttWebSocket(ctxFor(fake), {
      model: "saaras:v3",
      mode: "codemix",
      languageCode: "unknown",
      sampleRate: 16000,
      frames: [pcm.subarray(0, 8000), pcm.subarray(8000)],
      frameMs: 100,
      realtime: false,
    });
    assert.equal(ws.transcript, "Yes, that works for me.");
    assert.ok(ws.ms.finalAfterAudio! >= 0);
    assert.deepEqual(
      [
        fake.calls[2]!.endpoint,
        fake.calls[2]!.model,
        fake.calls[2]!.mode,
        fake.calls[2]!.sampleRate,
      ],
      ["stt-ws", "saaras:v3", "codemix", 16000],
    );
  });
  test("a socket that never answers times out (no hang)", async () => {
    const silent: Transport = {
      name: "fake",
      fetch: (async () => new Response("")) as typeof fetch,
      openSocket: () =>
        ({ readyState: 0, send() {}, close() {}, addEventListener() {} }) as SocketLike,
    };
    await assert.rejects(
      ttsWebSocket(ctxFor(silent, 50), {
        model: "bulbul:v3",
        speaker: "priya",
        languageCode: "en-IN",
        text: "x",
        sampleRate: 16000,
        codec: "linear16",
      }),
      (e: SpeechCallError) => e.kind === "timeout",
    );
  });
  test("a WebSocket error message (e.g. bad config) is surfaced with its code", async () => {
    const fake = new FakeSarvam({
      faults: [{ when: (c) => c.endpoint === "stt-ws", respond: { status: 400 } }],
    });
    await assert.rejects(
      sttWebSocket(ctxFor(fake), {
        model: "saaras:v3",
        mode: "codemix",
        languageCode: "unknown",
        sampleRate: 8000,
        frames: [new Int16Array(800)],
        frameMs: 100,
        realtime: false,
      }),
      (e: SpeechCallError) => e.kind === "http" && e.status === 400,
    );
  });
});

/* ------------------------------------------------------------------ validation */

describe("result validation", () => {
  test("silent TTS audio fails validation; the STT that depends on it is skipped at no cost", async () => {
    const fake = new FakeSarvam({
      faults: [{ when: (c) => c.endpoint === "tts", respond: { silent: true } }],
    });
    const out = await run(
      pick("T1-v3-16k:en-greeting", "S1-v3-codemix-16k:T1-v3-16k:en-greeting"),
      fake,
    );
    assert.equal(out.items[0]!.status, "failed");
    assert.match(out.items[0]!.validation.problems.join(), /silent/);
    assert.equal(out.items[1]!.status, "skipped");
    assert.equal(out.items[1]!.attempts.length, 0);
    assert.equal(fake.calls.length, 1);
  });
  test("audio at the wrong sample rate or in the wrong codec fails validation", async () => {
    const base = new FakeSarvam();
    const wrongRate: Transport = {
      ...base,
      name: "fake",
      openSocket: base.openSocket.bind(base),
      fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body = JSON.parse(String(init!.body));
        return base.fetch(input, {
          ...init,
          body: JSON.stringify({ ...body, speech_sample_rate: 22050, output_audio_codec: "wav" }),
        });
      }) as typeof fetch,
    };
    const out = await run(
      pick("T2-v3-8k:en-price", "P1-tts-mulaw-probe:en-appointment"),
      wrongRate,
    );
    assert.match(out.items[0]!.validation.problems.join(), /sample rate 22050, expected 8000/);
    assert.match(out.items[1]!.validation.problems.join(), /format pcm16, expected mulaw/);
  });
  test("STT accuracy: a transcript that drops digits fails the entity check (and the criterion)", async () => {
    const fake = new FakeSarvam({ corrupt: (t) => t.replace(/0/g, "") });
    const out = await run(
      pick("T1-v3-16k:en-phone-plain", "S1-v3-codemix-16k:T1-v3-16k:en-phone-plain"),
      fake,
    );
    const stt = out.items[1]!;
    assert.equal(stt.status, "ok", "a wrong transcript is a valid answer, not a failed request");
    assert.equal(stt.metrics!.entities[0]!.ok, false);
    const results = buildResults(2, out, new Ledger(P, defaultLimits(40, PLAN)), { mode: "test" });
    assert.equal(results.summary.criteria[1]!.pass, false);
  });
  test("an STT answer without a transcript is a protocol failure", async () => {
    const fake = new FakeSarvam({
      faults: [{ when: (c) => c.endpoint === "stt", respond: { malformed: true } }],
    });
    const out = await run(
      pick("T1-v3-16k:en-greeting", "S1-v3-codemix-16k:T1-v3-16k:en-greeting"),
      fake,
    );
    assert.equal(out.items[1]!.status, "failed");
    assert.equal(out.items[1]!.attempts[0]!.outcome, "protocol");
  });
  test("the mu-law STT probe sends a G.711 WAV at 8 kHz", async () => {
    const fake = new FakeSarvam();
    const out = await run(
      pick("T2-v3-8k:hi-phone-plain", "P2-stt-mulaw-probe:T2-v3-8k:hi-phone-plain"),
      fake,
    );
    assert.equal(out.items[1]!.status, "ok");
    assert.equal(fake.calls[1]!.sampleRate, 8000);
    assert.equal(out.items[1]!.transcript, FIXTURES.find((f) => f.id === "hi-phone-plain")!.text);
  });
});

/* ------------------------------------------------------------------ plan coverage */

describe("plan covers what was asked, within the approved volumes", () => {
  const tts = PLAN.filter(isTts) as TtsItem[];
  const stt = PLAN.filter((i) => !isTts(i)) as SttItem[];
  test("volumes: <= 6,000 bulbul:v3 chars, <= 1,200 bulbul:v4-flash chars, <= 720 s STT (estimate); cost under ₹40", () => {
    const s = summarize(PLAN, P);
    assert.ok(s.ttsChars["bulbul:v3"] <= 6000, String(s.ttsChars["bulbul:v3"]));
    assert.ok(s.ttsChars["bulbul:v4-flash"] <= 1200);
    assert.ok(s.sttSecondsEstimate <= 720);
    assert.ok(s.estimateInclGst < 40);
  });
  test("models: only bulbul:v3 / v4-flash and saaras:v3 / v4; both comparisons present", () => {
    assert.deepEqual([...new Set(tts.map((i) => i.model))].sort(), [
      "bulbul:v3",
      "bulbul:v4-flash",
    ]);
    assert.deepEqual([...new Set(stt.map((i) => i.model))].sort(), ["saaras:v3", "saaras:v4"]);
  });
  test("voices: v3 short names only on v3; v4 catalog IDs only on v4-flash; priya vs ishita/ratan for English", () => {
    for (const i of tts) assert.equal(i.model === "bulbul:v4-flash", i.speaker.includes("_"), i.id);
    for (const v of new Set(tts.filter((i) => i.model === "bulbul:v4-flash").map((i) => i.speaker)))
      assert.ok(Object.values(V4_FLASH_VOICES).includes(v));
    const en = tts.filter(
      (i) =>
        i.stage === "T3-v3-en-voices" || (i.stage === "T1-v3-16k" && i.languageCode === "en-IN"),
    );
    assert.deepEqual([...new Set(en.map((i) => i.speaker))].sort(), ["ishita", "priya", "ratan"]);
  });
  test("languages and variants: te/hi/en native, te/hi code-mixed, te/hi romanized; every category", () => {
    const seen = new Set(
      tts
        .map((i) => FIXTURES.find((f) => f.id === i.fixtureId)!)
        .map((f) => `${f.lang}/${f.variant}`),
    );
    for (const k of [
      "te-IN/native",
      "hi-IN/native",
      "en-IN/native",
      "te-IN/code-mixed",
      "hi-IN/code-mixed",
      "te-IN/romanized",
      "hi-IN/romanized",
    ])
      assert.ok(seen.has(k), k);
    const cats = new Set(FIXTURES.map((f) => f.category));
    for (const c of ["appointment", "date", "time", "price", "phone-plain", "phone-grouped"])
      assert.ok(cats.has(c as never), c);
  });
  test("telephony and codecs: 8 kHz TTS and STT; the mu-law probes are isolated and the only mu-law", () => {
    assert.ok(tts.some((i) => i.sampleRate === 8000 && i.codec === "wav"));
    assert.ok(stt.some((i) => i.input === "wav8k") && stt.some((i) => i.input === "pcm8k"));
    const mulaw = [
      ...tts.filter((i) => i.codec === "mulaw"),
      ...stt.filter((i) => i.input === "mulaw8k"),
    ];
    assert.ok(mulaw.length === 4 && mulaw.every((i) => i.probe && i.stage.startsWith("P")));
    assert.ok(PLAN.filter((i) => i.probe).every((i) => i.stage.startsWith("P")));
  });
  test("streaming: TTS over HTTP stream and WebSocket; STT over WebSocket at 16 and 8 kHz", () => {
    assert.ok(tts.some((i) => i.kind === "tts-http") && tts.some((i) => i.kind === "tts-ws"));
    assert.ok(
      stt.some((i) => i.kind === "stt-ws" && i.input === "pcm16k") &&
        stt.some((i) => i.kind === "stt-ws" && i.input === "pcm8k"),
    );
  });
  test("every STT item's source TTS comes earlier in the plan; ids are unique", () => {
    const pos = new Map(PLAN.map((i, n) => [i.id, n]));
    assert.equal(pos.size, PLAN.length);
    for (const s of stt) assert.ok((pos.get(s.source) ?? Infinity) < pos.get(s.id)!, s.id);
  });
  test("synthetic data only: every phone-like number starts with 1 (no Indian mobile does); no email/URL", () => {
    for (const f of FIXTURES) {
      for (const m of f.text.replace(/(\d) (\d)/g, "$1$2").match(/\d{7,}/g) ?? [])
        assert.ok(m.startsWith("1"), `${f.id}: ${m}`);
      assert.ok(!/@|https?:/.test(f.text), f.id);
    }
    for (const i of tts)
      assert.ok(textOf(i).length <= 2500, "within Sarvam's 2,500-character REST limit");
  });
});

/* ------------------------------------------------------------------ CLI + report */

describe("CLI: dry run and simulation produce plan, JSON and report offline", () => {
  test("dry run prints volumes and cost, and no plan hash without entered prices", async () => {
    const lines: string[] = [];
    assert.equal(await main(["node", "x"], {}, { log: (l) => lines.push(l), clock }), 0);
    const text = lines.join("\n");
    assert.match(text, /294 requests \(4 isolated probes\)/);
    assert.match(text, /bulbul:v3 \d+, bulbul:v4-flash \d+/);
    assert.match(text, /no plan hash: SARVAM_PRICE_STT_INR_PER_MIN is required/);
  });
  test("simulation writes results.json and report.md; all criteria pass on the fake's perfect answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "speech-sim-"));
    try {
      const before = guard.blocked.length;
      const code = await main(
        ["node", "x", "--simulate", "--out", dir],
        {},
        { log: () => {}, clock },
      );
      assert.equal(code, 0);
      const r = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
      assert.equal(r.summary.requests.planned, 294);
      assert.equal(r.summary.requests.ok, 294);
      assert.ok(r.summary.criteria.every((c: { pass: boolean }) => c.pass));
      assert.ok(r.summary.spend.inclGstInr < 40);
      // Every request has an ID except TTS WebSocket ones (the documented protocol carries none).
      const ttsWs = r.items.filter((i: { kind: string }) => i.kind === "tts-ws").length;
      assert.equal(ttsWs, 4);
      assert.equal(r.summary.requestIds.length, 294 - ttsWs);
      const md = readFileSync(join(dir, "report.md"), "utf8");
      assert.match(md, /Offline run: all responses came from the in-process fake/);
      assert.match(md, /## Pass criteria/);
      assert.equal(guard.blocked.length, before, "the simulation made no network attempt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("simulation report renders failures", async () => {
    const fake = new FakeSarvam({
      faults: [{ when: () => true, respond: { status: 400 }, times: 1 }],
    });
    const out = await run(pick("T1-v3-16k:en-greeting"), fake);
    const md = markdownReport(
      buildResults(1, out, new Ledger(P, defaultLimits(40, PLAN)), { mode: "test" }),
    );
    assert.match(md, /`T1-v3-16k:en-greeting`: HTTP 400/);
  });
});
