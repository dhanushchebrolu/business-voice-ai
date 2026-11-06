/**
 * Transcription accuracy: normalization, character/word error rates and
 * entity checks. Entities (digits, times, prices, key words) are the pass
 * criterion that matters for bookings; CER/WER are reported for comparison.
 */
import type { Entity } from "./fixtures.ts";

const NATIVE_DIGITS = /[०-९౦-౯]/g;

export function normalize(text: string): string {
  return (
    text
      .normalize("NFC")
      .replace(NATIVE_DIGITS, (d) => {
        const c = d.codePointAt(0)!;
        return String(c >= 0x0c66 ? c - 0x0c66 : c - 0x0966);
      })
      .toLowerCase()
      // Zero-width joiners appear in Telugu/Devanagari input; they carry no sound.
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      // Digit groups: "12345 67890", "1,234", "98-76" -> contiguous digits.
      .replace(/(\d)[\s,-](?=\d)/g, "$1")
      .replace(/[.,!?\u0964;:"'\u201c\u201d\u2018\u2019()[\]{}\u2026-]+(?!\d)/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Times keep their colon/period ("4:30"); normalize() would otherwise drop it. */
const normalizeForEntities = (text: string) =>
  normalize(text.replace(/(\d)[:.](\d)/g, "$1§$2")).replace(/§/g, ":");

export function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length]!;
}

/** Character error rate on normalized text, over grapheme clusters (an Indic syllable is one unit). */
export function cer(reference: string, hypothesis: string): number {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const g = (s: string) => [...seg.segment(normalize(s).replace(/ /g, ""))].map((x) => x.segment);
  const ref = g(reference);
  return ref.length ? levenshtein(ref, g(hypothesis)) / ref.length : hypothesis.trim() ? 1 : 0;
}

export function wer(reference: string, hypothesis: string): number {
  const w = (s: string) => normalize(s).split(" ").filter(Boolean);
  const ref = w(reference);
  return ref.length ? levenshtein(ref, w(hypothesis)) / ref.length : hypothesis.trim() ? 1 : 0;
}

export interface EntityResult {
  kind: Entity["kind"];
  ok: boolean;
  accepted: string[];
}

export function checkEntities(entities: Entity[], transcript: string): EntityResult[] {
  const t = normalizeForEntities(transcript);
  const compact = t.replace(/ /g, "");
  return entities.map((e) => {
    const ok = e.accept.some((form) => {
      const f = normalizeForEntities(form);
      // Digit-only forms may be split by spaces in the transcript ("1234 567 890").
      return /^\d+$/.test(f.replace(/ /g, ""))
        ? compact.includes(f.replace(/ /g, ""))
        : t.includes(f);
    });
    return { kind: e.kind, ok, accepted: e.accept };
  });
}

export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!;
}
