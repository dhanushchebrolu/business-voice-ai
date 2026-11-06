// Build-time check that EVERY offline asset the installed turn detector
// loads at runtime is present where the runtime looks for it, using the
// runtime's own loaders with network access disabled. Run in the final
// image as the `node` user (so paths and permissions are that user's).
//
// What @livekit/agents-plugin-livekit loads for the multilingual model
// (turn_detector/base.js, the only model this agent uses):
//   1. onnx/model_q8.onnx  downloadFileToCacheDir({ localFileOnly: true })
//                          -> ~/.cache/huggingface/hub (here /home/node/.cache)
//   2. languages.json      same loader (per-language thresholds; if missing,
//                          the runtime's promise rejects and end-of-turn
//                          detection waits forever)
//   3. tokenizer           AutoTokenizer.from_pretrained(repo,
//                          { revision, local_files_only: true })
//                          -> node_modules/@huggingface/transformers/.cache
//                          (needs prepare-model-cache.mjs; see there)
// Exit 0 = the multilingual turn detector starts offline.
//
// Test seams (not used in the image): HOME (ONNX/languages cache root) and
// CLICKAI_TRANSFORMERS_CACHE_DIR (tokenizer cache).
import { existsSync, readFileSync, statSync } from "node:fs";

const failures = [];
try {
  const { initializeLogger } = await import("@livekit/agents");
  initializeLogger({ pretty: false, level: "fatal" });
  const { downloadFileToCacheDir } = await import("@livekit/agents-plugin-livekit");
  // The constants module is not in the package's "exports"; resolve it next
  // to the package entry so the check uses the plugin's own repo/revision.
  const { HG_MODEL_REPO, MODEL_REVISIONS, ONNX_FILEPATH } = await import(
    new URL("./turn_detector/constants.js", import.meta.resolve("@livekit/agents-plugin-livekit"))
      .href
  );
  const { AutoTokenizer, env } = await import("@huggingface/transformers");
  if (process.env.CLICKAI_TRANSFORMERS_CACHE_DIR)
    env.cacheDir = process.env.CLICKAI_TRANSFORMERS_CACHE_DIR;
  // Never fetch here: a build host WITH network would otherwise pass a check
  // that an offline pod fails.
  env.allowRemoteModels = false;
  const revision = MODEL_REVISIONS.multilingual;

  const local = async (path) =>
    downloadFileToCacheDir({ repo: HG_MODEL_REPO, path, revision, localFileOnly: true });

  try {
    const onnx = await local(ONNX_FILEPATH);
    if (!existsSync(onnx) || statSync(onnx).size < 1_000_000)
      failures.push(`${ONNX_FILEPATH}: missing or truncated at ${onnx}`);
  } catch (e) {
    failures.push(`${ONNX_FILEPATH}: not in cache (${String(e).slice(0, 160)})`);
  }
  try {
    const langs = JSON.parse(readFileSync(await local("languages.json"), "utf8"));
    if (!langs || typeof langs !== "object" || Object.keys(langs).length === 0)
      failures.push("languages.json: empty or not an object");
  } catch (e) {
    failures.push(`languages.json: not in cache or invalid (${String(e).slice(0, 160)})`);
  }
  try {
    await AutoTokenizer.from_pretrained(HG_MODEL_REPO, { revision, local_files_only: true });
  } catch (e) {
    failures.push(
      `tokenizer: does not load offline (${String(e).slice(0, 120)}); ` +
        "run deploy/prepare-model-cache.mjs after download-files",
    );
  }
} catch (e) {
  failures.push(`could not load the plugin: ${String(e).slice(0, 200)}`);
}
if (failures.length) {
  console.error("verify-models: FAILED\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("verify-models: ok (onnx model, languages.json and tokenizer load offline)");
