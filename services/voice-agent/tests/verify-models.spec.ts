import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * F3: deploy/verify-models.mjs and deploy/prepare-model-cache.mjs, run as
 * separate processes (as in the image) against fixture caches laid out
 * exactly as download-files writes them. The fixtures are SYNTHETIC (a tiny
 * word-level tokenizer, a dummy ONNX file): this proves the loaders, paths
 * and offline behaviour of the INSTALLED libraries, not the real model.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const VERIFY = join(here, "../deploy/verify-models.mjs");
const PREPARE = join(here, "../deploy/prepare-model-cache.mjs");
const REV = "v0.4.1-intl"; // MODEL_REVISIONS.multilingual of the installed plugin
const REPO_HUB = "models--livekit--turn-detector";

interface Fixture {
  home: string;
  tf: string;
  cleanup: () => void;
}
function fixture(parts: { onnx?: boolean; languages?: boolean; tokenizer?: boolean }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "verify-models-"));
  const home = join(root, "home");
  const tf = join(root, "tf-cache");
  const hub = join(home, ".cache/huggingface/hub", REPO_HUB);
  const snap = join(hub, "snapshots", "abc123");
  mkdirSync(join(hub, "refs"), { recursive: true });
  mkdirSync(join(snap, "onnx"), { recursive: true });
  writeFileSync(join(hub, "refs", REV), "abc123");
  if (parts.onnx) writeFileSync(join(snap, "onnx/model_q8.onnx"), Buffer.alloc(2_000_000));
  if (parts.languages)
    writeFileSync(
      join(snap, "languages.json"),
      JSON.stringify({ en: { threshold: 0.5 }, hi: { threshold: 0.4 } }),
    );
  if (parts.tokenizer) {
    const dir = join(tf, "livekit/turn-detector", REV);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tokenizer.json"),
      JSON.stringify({
        version: "1.0",
        truncation: null,
        padding: null,
        added_tokens: [],
        normalizer: null,
        pre_tokenizer: { type: "Whitespace" },
        post_processor: null,
        decoder: null,
        model: { type: "WordLevel", vocab: { "[UNK]": 0, hello: 1 }, unk_token: "[UNK]" },
      }),
    );
    writeFileSync(
      join(dir, "tokenizer_config.json"),
      JSON.stringify({ tokenizer_class: "PreTrainedTokenizer" }),
    );
  }
  return { home, tf, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function run(script: string, f: Fixture) {
  const r = spawnSync(process.execPath, [script], {
    cwd: join(here, ".."),
    env: { ...process.env, HOME: f.home, CLICKAI_TRANSFORMERS_CACHE_DIR: f.tf },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("F3: model verification covers every runtime asset", () => {
  test("nothing downloaded: fails and names all three assets", () => {
    const f = fixture({});
    try {
      const r = run(VERIFY, f);
      assert.equal(r.code, 1);
      assert.match(r.out, /onnx\/model_q8\.onnx: not in cache/);
      assert.match(r.out, /languages\.json: not in cache/);
      assert.match(r.out, /tokenizer: does not load offline/);
    } finally {
      f.cleanup();
    }
  });
  test("languages.json missing (the asset the old check skipped): fails", () => {
    const f = fixture({ onnx: true, tokenizer: true });
    try {
      assert.equal(run(PREPARE, f).code, 0);
      const r = run(VERIFY, f);
      assert.equal(r.code, 1);
      assert.match(r.out, /languages\.json/);
      assert.doesNotMatch(r.out, /model_q8\.onnx/);
    } finally {
      f.cleanup();
    }
  });
  test("exactly what download-files writes: the tokenizer does NOT load offline (transformers 4.2.0 'main'-key lookup)", () => {
    const f = fixture({ onnx: true, languages: true, tokenizer: true });
    try {
      const r = run(VERIFY, f);
      assert.equal(r.code, 1);
      assert.match(r.out, /tokenizer: does not load offline/);
      assert.match(r.out, /tokenizer_class/);
    } finally {
      f.cleanup();
    }
  });
  test("after prepare-model-cache: every asset loads offline -> verification succeeds", () => {
    const f = fixture({ onnx: true, languages: true, tokenizer: true });
    try {
      const p = run(PREPARE, f);
      assert.equal(p.code, 0, p.out);
      const r = run(VERIFY, f);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /verify-models: ok/);
    } finally {
      f.cleanup();
    }
  });
  test("prepare-model-cache fails loudly when download-files did not run", () => {
    const f = fixture({});
    try {
      const p = run(PREPARE, f);
      assert.equal(p.code, 1);
      assert.match(p.out, /prepare-model-cache: FAILED/);
    } finally {
      f.cleanup();
    }
  });
});
