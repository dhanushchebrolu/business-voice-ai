/**
 * Phase 3 Sarvam STT/TTS harness. Offline by default (network disabled).
 *
 *   node --experimental-strip-types bench/sarvam-speech-smoke.ts                 # dry run: plan + cost
 *   node --experimental-strip-types bench/sarvam-speech-smoke.ts --simulate --out <dir>
 *   (live, PAID: see bench/speech/gates.ts; requires approval and --confirm-plan)
 *
 * Isolated from production: nothing under src/ is changed or used at runtime
 * except the LLM adapter's auth guard (imported read-only).
 */
import { main } from "./speech/cli.ts";

process.exitCode = await main(process.argv, process.env, { log: (l) => console.log(l) });
