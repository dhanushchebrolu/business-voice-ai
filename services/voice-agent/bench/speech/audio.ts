/**
 * Audio helpers for the speech harness: WAV build/parse (PCM16 and G.711
 * mu-law), mu-law codec, resampling to 8 kHz telephony audio, and simple
 * signal checks. Pure and synchronous; no network, no files.
 */

export type WavFormat = "pcm16" | "mulaw" | "alaw";

export interface WavInfo {
  format: WavFormat;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Bytes of audio payload (the `data` chunk). */
  dataBytes: number;
  durationSec: number;
  /** Offset of the `data` payload in the buffer. */
  dataOffset: number;
}

export class AudioFormatError extends Error {
  override name = "AudioFormatError";
}

const FORMAT_CODES: Record<number, WavFormat> = { 1: "pcm16", 6: "alaw", 7: "mulaw" };

/** Parses and validates a RIFF/WAVE buffer. Throws AudioFormatError on anything malformed. */
export function parseWav(buf: Uint8Array): WavInfo {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 44) throw new AudioFormatError(`too short for WAV (${b.length} bytes)`);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE")
    throw new AudioFormatError("not a RIFF/WAVE file");
  let off = 12;
  let fmt: { code: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    let size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > b.length) throw new AudioFormatError("truncated fmt chunk");
      fmt = {
        code: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new AudioFormatError("data chunk before fmt chunk");
      const format = FORMAT_CODES[fmt.code];
      if (!format) throw new AudioFormatError(`unsupported WAV format code ${fmt.code}`);
      if (format === "pcm16" && fmt.bits !== 16)
        throw new AudioFormatError(`PCM WAV must be 16-bit (got ${fmt.bits})`);
      if (format !== "pcm16" && fmt.bits !== 8)
        throw new AudioFormatError(`${format} WAV must be 8-bit (got ${fmt.bits})`);
      if (fmt.channels < 1 || fmt.rate < 1000) throw new AudioFormatError("invalid channels/rate");
      // Streaming encoders may write 0 or 0xFFFFFFFF as an unknown size: use what is present.
      if (size === 0 || size === 0xffffffff || body + size > b.length) size = b.length - body;
      const bytesPerSec = fmt.rate * fmt.channels * (fmt.bits / 8);
      return {
        format,
        sampleRate: fmt.rate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        dataBytes: size,
        durationSec: size / bytesPerSec,
        dataOffset: body,
      };
    }
    off = body + size + (size % 2);
  }
  throw new AudioFormatError("no data chunk");
}

function header(
  format: WavFormat,
  sampleRate: number,
  channels: number,
  dataBytes: number,
): Buffer {
  const bits = format === "pcm16" ? 16 : 8;
  const code = format === "pcm16" ? 1 : format === "mulaw" ? 7 : 6;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(code, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  h.writeUInt16LE(channels * (bits / 8), 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function pcm16ToWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return new Uint8Array(Buffer.concat([header("pcm16", sampleRate, 1, data.length), data]));
}

export function muLawToWav(bytes: Uint8Array, sampleRate: number): Uint8Array {
  return new Uint8Array(
    Buffer.concat([header("mulaw", sampleRate, 1, bytes.length), Buffer.from(bytes)]),
  );
}

/** Mono PCM16 samples of a WAV (mu-law/a-law decoded only for mu-law). */
export function wavSamples(buf: Uint8Array): { samples: Int16Array; sampleRate: number } {
  const info = parseWav(buf);
  if (info.channels !== 1) throw new AudioFormatError("only mono audio is used in the harness");
  const payload = buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  if (info.format === "pcm16") {
    const copy = new Uint8Array(payload.byteLength - (payload.byteLength % 2));
    copy.set(payload.subarray(0, copy.byteLength));
    return { samples: new Int16Array(copy.buffer), sampleRate: info.sampleRate };
  }
  if (info.format === "mulaw")
    return { samples: muLawDecode(payload), sampleRate: info.sampleRate };
  throw new AudioFormatError("a-law decoding is not needed by the harness");
}

/* ------------------------------------------------------------------ G.711 mu-law */

const BIAS = 0x84;
const CLIP = 32635;

export function muLawEncode(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]!;
    const sign = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

export function muLawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i]! & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    out[i] = sign ? -magnitude : magnitude;
  }
  return out;
}

/* ------------------------------------------------------------------ signal */

/** Linear-interpolation resampler with a short moving-average pre-filter when downsampling. */
export function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  let src = samples;
  if (to < from) {
    const k = Math.max(1, Math.round(from / to));
    const f = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let sum = 0;
      let n = 0;
      for (let j = i - k + 1; j <= i; j++)
        if (j >= 0) {
          sum += samples[j]!;
          n++;
        }
      f[i] = Math.round(sum / n);
    }
    src = f;
  }
  const outLen = Math.floor((src.length * to) / from);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * from) / to;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const t = pos - i0;
    out[i] = Math.round(src[i0]! * (1 - t) + src[i1]! * t);
  }
  return out;
}

export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let acc = 0;
  for (const s of samples) acc += s * s;
  return Math.sqrt(acc / samples.length);
}

/** A synthetic test signal (never speech): a tone, for offline fixtures only. */
export function tone(freqHz: number, ms: number, sampleRate: number, amplitude = 8000): Int16Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
  return out;
}

/** Splits PCM16 into real-time frames (e.g. 100 ms) for streaming. */
export function frames(samples: Int16Array, sampleRate: number, frameMs: number): Int16Array[] {
  const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const out: Int16Array[] = [];
  for (let i = 0; i < samples.length; i += size) out.push(samples.subarray(i, i + size));
  return out;
}
