// Run in the image build right after `npx livekit-agents download-files`.
//
// Why: @huggingface/transformers 4.2.0 decides WHICH tokenizer files exist
// with get_tokenizer_files(), which calls
//   get_file_metadata(repo, "tokenizer_config.json", {})
// i.e. WITHOUT the revision and WITHOUT local_files_only. That lookup uses
// the cache key for revision "main" (<cacheDir>/livekit/turn-detector/
// tokenizer_config.json), but download-files stores the tokenizer under the
// revision key (<cacheDir>/livekit/turn-detector/<revision>/...). So at
// runtime the lookup misses the cache and goes to huggingface.co; offline it
// finds nothing and AutoTokenizer fails ("reading 'tokenizer_class'").
// Reproduced with the installed version (tests/verify-models.spec.ts).
//
// Fix without patching the library: also place tokenizer_config.json under
// the "main" key. Only its EXISTENCE is consulted there; the files actually
// loaded are still the revision-keyed ones (the runtime passes the revision).
//
// CLICKAI_TRANSFORMERS_CACHE_DIR overrides the cache directory (tests only).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const { env } = await import("@huggingface/transformers");
if (process.env.CLICKAI_TRANSFORMERS_CACHE_DIR)
  env.cacheDir = process.env.CLICKAI_TRANSFORMERS_CACHE_DIR;
const { MODEL_REVISIONS, HG_MODEL_REPO } = await import(
  new URL("./turn_detector/constants.js", import.meta.resolve("@livekit/agents-plugin-livekit"))
    .href
);

const repoDir = join(env.cacheDir, HG_MODEL_REPO);
// The multilingual model is the one this agent uses; its config is the one copied.
const source = join(repoDir, MODEL_REVISIONS.multilingual, "tokenizer_config.json");
const target = join(repoDir, "tokenizer_config.json");
if (!existsSync(source)) {
  console.error(`prepare-model-cache: FAILED - ${source} missing (did download-files run?)`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`prepare-model-cache: ok (${target})`);
