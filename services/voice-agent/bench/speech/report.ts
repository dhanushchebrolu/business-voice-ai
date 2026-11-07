/**
 * Results: a machine-readable JSON document and a human-readable Markdown
 * report. Neither ever contains headers, keys or audio; transcripts are of
 * synthetic fixtures only.
 */
import { percentile } from "./metrics.ts";
import type { Ledger } from "./pricing.ts";
import type { ItemResult, RunOutcome } from "./runner.ts";

export interface Criterion {
  name: string;
  pass: boolean | null; // null = not evaluated (nothing ran)
  detail: string;
}

export interface Results {
  meta: Record<string, unknown>;
  summary: {
    stopReason: string | null;
    requests: { planned: number; ok: number; failed: number; skipped: number; notRun: number };
    attempts: { billed: number; notSent: number; retries: number };
    spend: { exclGstInr: number; inclGstInr: number; capInclGstInr: number; gstRate: number };
    volumes: { ttsChars: Record<string, number>; sttSeconds: number };
    criteria: Criterion[];
    byStage: Record<string, { ok: number; failed: number; skipped: number; notRun: number }>;
    accuracy: Record<
      string,
      {
        items: number;
        meanCer: number | null;
        entityPassRate: number | null;
        digitPassRate: number | null;
      }
    >;
    latencyMs: Record<
      string,
      { n: number; p50: number | null; p95: number | null; max: number | null }
    >;
    requestIds: string[];
  };
  items: ItemResult[];
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function buildResults(
  plannedCount: number,
  out: RunOutcome,
  ledger: Ledger,
  meta: Record<string, unknown>,
): Results {
  const items = out.items;
  const count = (s: ItemResult["status"]) => items.filter((i) => i.status === s).length;
  const byStage: Results["summary"]["byStage"] = {};
  for (const i of items) {
    const st = (byStage[i.stage] ??= { ok: 0, failed: 0, skipped: 0, notRun: 0 });
    if (i.status === "ok") st.ok++;
    else if (i.status === "failed") st.failed++;
    else if (i.status === "skipped") st.skipped++;
    else st.notRun++;
  }

  // Accuracy per STT stage and per language/variant.
  const accuracy: Results["summary"]["accuracy"] = {};
  const stt = items.filter((i) => i.metrics);
  const groups = new Map<string, ItemResult[]>();
  for (const i of stt) {
    for (const key of [i.stage, `${i.stage} | ${i.lang} ${i.variant}`])
      groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  for (const [key, g] of groups) {
    const ents = g.flatMap((i) => i.metrics!.entities);
    const digitEnts = ents.filter((e) => e.kind !== "keyword");
    accuracy[key] = {
      items: g.length,
      meanCer: (() => {
        const m = mean(g.map((i) => i.metrics!.cer));
        return m === null ? null : round(m);
      })(),
      entityPassRate: ents.length ? round(ents.filter((e) => e.ok).length / ents.length) : null,
      digitPassRate: digitEnts.length
        ? round(digitEnts.filter((e) => e.ok).length / digitEnts.length)
        : null,
    };
  }

  // Latency per request kind and measurement.
  const latencyMs: Results["summary"]["latencyMs"] = {};
  const okAttempts = items.flatMap((i) =>
    i.attempts.filter((a) => a.outcome === "ok" || a.outcome === "invalid").map((a) => ({ i, a })),
  );
  const keys = new Set(
    okAttempts.flatMap(({ i, a }) => Object.keys(a.ms).map((k) => `${i.kind}.${k}`)),
  );
  for (const k of keys) {
    const [kind, m] = k.split(".") as [string, string];
    const v = okAttempts
      .filter(({ i }) => i.kind === kind)
      .map(({ a }) => a.ms[m]!)
      .filter((x) => x >= 0);
    latencyMs[k] = {
      n: v.length,
      p50: round(percentile(v, 0.5) ?? -1, 1),
      p95: round(percentile(v, 0.95) ?? -1, 1),
      max: v.length ? round(Math.max(...v), 1) : null,
    };
  }

  // Pass criteria (agreed in the research plan).
  const nonProbeTts = items.filter(
    (i) => i.kind.startsWith("tts") && !i.probe && i.status !== "not-run" && i.status !== "skipped",
  );
  const prodStt = items.filter((i) => i.stage.startsWith("S1-") && i.metrics);
  const prodDigits = prodStt.flatMap((i) =>
    i.metrics!.entities.filter((e) => e.kind !== "keyword"),
  );
  // Only answers that report a language count (the STT WebSocket may not report one).
  const autoDetect = items.filter(
    (i) => i.metrics && i.languageRequested === "unknown" && i.variant === "native",
  );
  const singleLang = autoDetect.filter((i) => i.detectedLanguage);
  const criteria: Criterion[] = [
    {
      name: "TTS: every non-probe request returns valid audio (format, rate, duration, not silent)",
      pass: nonProbeTts.length ? nonProbeTts.every((i) => i.status === "ok") : null,
      detail: `${nonProbeTts.filter((i) => i.status === "ok").length}/${nonProbeTts.length} valid`,
    },
    {
      name: "STT (production saaras:v3 codemix): times, dates, prices and phone digits exact in >= 95% of entities",
      pass: prodDigits.length
        ? prodDigits.filter((e) => e.ok).length / prodDigits.length >= 0.95
        : null,
      detail: `${prodDigits.filter((e) => e.ok).length}/${prodDigits.length} entities`,
    },
    {
      name: "STT auto-detect: single-language items detected as their language",
      pass: singleLang.length ? singleLang.every((i) => i.detectedLanguage === i.lang) : null,
      detail: `${singleLang.filter((i) => i.detectedLanguage === i.lang).length}/${singleLang.length}${autoDetect.length > singleLang.length ? ` (${autoDetect.length - singleLang.length} reported no language)` : ""}`,
    },
    {
      name: "Spend stayed within the cap",
      pass: ledger.spentInclGst <= ledger.limits.capInclGst + 1e-9,
      detail: `₹${round(ledger.spentInclGst)} of ₹${ledger.limits.capInclGst} incl. GST`,
    },
  ];

  return {
    meta,
    summary: {
      stopReason: out.stopReason,
      requests: {
        planned: plannedCount,
        ok: count("ok"),
        failed: count("failed"),
        skipped: count("skipped"),
        notRun: count("not-run"),
      },
      attempts: {
        billed: ledger.billedAttempts,
        notSent: ledger.freeAttempts,
        retries: items.reduce((a, i) => a + Math.max(0, i.attempts.length - 1), 0),
      },
      spend: {
        exclGstInr: round(ledger.spentExclGst),
        inclGstInr: round(ledger.spentInclGst),
        capInclGstInr: ledger.limits.capInclGst,
        gstRate: ledger.prices.gstRate,
      },
      volumes: { ttsChars: { ...ledger.ttsCharsUsed }, sttSeconds: ledger.sttSecondsUsed },
      criteria,
      byStage,
      accuracy,
      latencyMs,
      requestIds: items.flatMap((i) =>
        i.attempts.map((a) => a.requestId).filter((x): x is string => !!x),
      ),
    },
    items,
  };
}

export function markdownReport(r: Results): string {
  const s = r.summary;
  const yes = (p: boolean | null) => (p === null ? "n/a" : p ? "PASS" : "FAIL");
  const lines = [
    `# Sarvam speech harness report`,
    ``,
    `Mode: **${String(r.meta.mode)}** · plan ${String(r.meta.planHash)} · ${String(r.meta.finishedAt)}`,
    r.meta.mode !== "live"
      ? `\n> Offline run: all responses came from the in-process fake, not Sarvam. Accuracy and latency figures are NOT measurements of Sarvam.\n`
      : "",
    `**Stop reason:** ${s.stopReason ?? "none (completed)"}`,
    ``,
    `## Spend`,
    `| | |`,
    `|---|---|`,
    `| Spent (excl. GST) | ₹${s.spend.exclGstInr} |`,
    `| Spent (incl. ${s.spend.gstRate * 100}% GST, assumed rate) | ₹${s.spend.inclGstInr} |`,
    `| Cap (incl. GST) | ₹${s.spend.capInclGstInr} |`,
    `| Billed attempts / retries / refused locally | ${s.attempts.billed} / ${s.attempts.retries} / ${s.attempts.notSent} |`,
    `| TTS characters | ${Object.entries(s.volumes.ttsChars)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ")} |`,
    `| STT seconds (billable, rounded up per request) | ${s.volumes.sttSeconds} |`,
    ``,
    `## Pass criteria`,
    `| Criterion | Result | Detail |`,
    `|---|---|---|`,
    ...s.criteria.map((c) => `| ${c.name} | ${yes(c.pass)} | ${c.detail} |`),
    ``,
    `## Requests`,
    `Planned ${s.requests.planned}: ok ${s.requests.ok}, failed ${s.requests.failed}, skipped ${s.requests.skipped}, not run ${s.requests.notRun}.`,
    ``,
    `| Stage | ok | failed | skipped | not run |`,
    `|---|---|---|---|---|`,
    ...Object.entries(s.byStage).map(
      ([k, v]) => `| ${k} | ${v.ok} | ${v.failed} | ${v.skipped} | ${v.notRun} |`,
    ),
    ``,
    `## STT accuracy`,
    `| Group | items | mean CER | entities | times/dates/prices/digits |`,
    `|---|---|---|---|---|`,
    ...Object.entries(s.accuracy).map(
      ([k, v]) =>
        `| ${k} | ${v.items} | ${v.meanCer ?? "-"} | ${v.entityPassRate ?? "-"} | ${v.digitPassRate ?? "-"} |`,
    ),
    ``,
    `## Latency (ms)`,
    `| Measure | n | p50 | p95 | max |`,
    `|---|---|---|---|---|`,
    ...Object.entries(s.latencyMs).map(
      ([k, v]) => `| ${k} | ${v.n} | ${v.p50} | ${v.p95} | ${v.max} |`,
    ),
    ``,
    `## Failures`,
    ...(r.items.filter((i) => i.status === "failed").length
      ? r.items
          .filter((i) => i.status === "failed")
          .map(
            (i) =>
              `- \`${i.id}\`${i.probe ? " (probe)" : ""}: ${[...i.validation.problems, ...i.attempts.map((a) => a.error).filter(Boolean)].join("; ")}`,
          )
      : ["None."]),
    ``,
    `Request IDs: ${s.requestIds.length} recorded (see JSON).`,
  ];
  return (
    lines
      .filter((l) => l !== "")
      .join("\n")
      .replace(/\n(#+ )/g, "\n\n$1") + "\n"
  );
}
