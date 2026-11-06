/**
 * Phase 2.19 smoke-test gates (bench/smoke-gates.ts), offline. These never run
 * the paid harness's request path: resolveSmokeGates is a pure function, and
 * the two process-level checks spawn the harness with gates that must refuse.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  noProxyBypassesSarvam,
  nodeSupportsEnvProxy,
  resolveSmokeGates,
} from "../bench/smoke-gates.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sk_gate_canary_4Rz";
const ARGV = ["node", "bench/sarvam-smoke.ts", "--out", "/tmp/x.json"];
const NODE = "v22.23.4";

const API_KEY_ENV = {
  SARVAM_SMOKE_APPROVED: "yes",
  SARVAM_SMOKE_BUDGET_INR: "50",
  SARVAM_API_KEY: KEY,
};
const PROXY_ENV = {
  SARVAM_SMOKE_APPROVED: "yes",
  SARVAM_SMOKE_BUDGET_INR: "50",
  SARVAM_SMOKE_AUTH_MODE: "proxy-injected",
  HTTPS_PROXY: "http://127.0.0.1:3128",
  NO_PROXY: "localhost,127.0.0.1,::1,registry.npmjs.org,.svc.cluster.local",
  NODE_USE_ENV_PROXY: "1",
};

const refuses = (env: Record<string, string | undefined>, re: RegExp, argv = ARGV, node = NODE) => {
  const g = resolveSmokeGates(env, argv, node);
  assert.equal(g.ok, false, `expected a refusal matching ${re}`);
  if (!g.ok) {
    assert.match(g.reason, re);
    assert.ok(!g.reason.includes(KEY), "reasons never contain the key");
  }
};

describe("smoke gates: mode selection is explicit", () => {
  test("SARVAM_SMOKE_AUTH_MODE unset or empty -> api-key mode with SARVAM_API_KEY", () => {
    for (const mode of [undefined, ""]) {
      const g = resolveSmokeGates({ ...API_KEY_ENV, SARVAM_SMOKE_AUTH_MODE: mode }, ARGV, NODE);
      assert.ok(g.ok);
      if (g.ok) assert.deepEqual(g.auth, { mode: "api-key", apiKey: KEY });
    }
  });
  test("explicit api-key mode", () => {
    const g = resolveSmokeGates({ ...API_KEY_ENV, SARVAM_SMOKE_AUTH_MODE: "api-key" }, ARGV, NODE);
    assert.ok(g.ok && g.auth.mode === "api-key");
  });
  test("proxy-looking environment without the explicit mode stays api-key (and needs a key)", () => {
    const { SARVAM_SMOKE_AUTH_MODE: _omit, ...rest } = PROXY_ENV;
    void _omit;
    refuses(rest, /SARVAM_API_KEY is not set/);
    const g = resolveSmokeGates({ ...rest, SARVAM_API_KEY: KEY }, ARGV, NODE);
    assert.ok(g.ok && g.auth.mode === "api-key");
  });
  test("SARVAM_SMOKE_AUTH_MODE=proxy-injected -> proxy mode, no key anywhere", () => {
    const g = resolveSmokeGates(PROXY_ENV, ARGV, NODE);
    assert.ok(g.ok);
    if (g.ok) {
      assert.deepEqual(g.auth, { mode: "proxy-injected" });
      assert.ok(!("apiKey" in g.auth));
    }
  });
  test("unknown or misspelled modes are refused", () => {
    for (const m of ["proxy", "Proxy-Injected", "PROXY-INJECTED", "auto", "none"])
      refuses({ ...API_KEY_ENV, SARVAM_SMOKE_AUTH_MODE: m }, /must be api-key or proxy-injected/);
  });
});

describe("smoke gates: proxy-injected refusals", () => {
  test("any SARVAM_API_KEY value (real, empty or placeholder) is refused: no fake key", () => {
    for (const v of [KEY, "", "dummy", "proxy-injected:no-local-credential"])
      refuses({ ...PROXY_ENV, SARVAM_API_KEY: v }, /unset SARVAM_API_KEY/);
  });
  test("HTTPS_PROXY is required (either case)", () => {
    refuses({ ...PROXY_ENV, HTTPS_PROXY: undefined }, /needs HTTPS_PROXY/);
    refuses({ ...PROXY_ENV, HTTPS_PROXY: "" }, /needs HTTPS_PROXY/);
    assert.ok(
      resolveSmokeGates(
        { ...PROXY_ENV, HTTPS_PROXY: undefined, https_proxy: "http://p:1" },
        ARGV,
        NODE,
      ).ok,
    );
  });
  test("NO_PROXY covering api.sarvam.ai is refused", () => {
    for (const np of [
      "api.sarvam.ai",
      "x,.sarvam.ai",
      "sarvam.ai",
      "*.sarvam.ai",
      "*",
      "API.SARVAM.AI:443",
    ]) {
      refuses({ ...PROXY_ENV, NO_PROXY: np }, /NO_PROXY bypasses/);
      refuses({ ...PROXY_ENV, NO_PROXY: undefined, no_proxy: np }, /NO_PROXY bypasses/);
    }
    assert.equal(noProxyBypassesSarvam("notsarvam.ai,api.sarvam.ai.example"), false);
  });
  test("NODE_USE_ENV_PROXY=1 is required (Node fetch ignores HTTPS_PROXY otherwise)", () => {
    for (const v of [undefined, "", "0", "true"])
      refuses({ ...PROXY_ENV, NODE_USE_ENV_PROXY: v }, /NODE_USE_ENV_PROXY=1/);
  });
  test("Node versions without NODE_USE_ENV_PROXY are refused", () => {
    refuses(PROXY_ENV, /Node >= 22\.21/, ARGV, "v22.20.0");
    refuses(PROXY_ENV, /Node >= 22\.21/, ARGV, "v24.4.0");
    for (const v of ["v22.21.0", "v22.23.4", "v23.0.0", "v24.5.0", "v25.1.0"])
      assert.ok(nodeSupportsEnvProxy(v), v);
  });
});

describe("smoke gates: shared refusals (both modes)", () => {
  for (const [label, env] of [
    ["api-key", API_KEY_ENV],
    ["proxy-injected", PROXY_ENV],
  ] as const) {
    test(`${label}: approval required`, () => {
      for (const v of [undefined, "", "no", "YES", "true"])
        refuses({ ...env, SARVAM_SMOKE_APPROVED: v }, /set SARVAM_SMOKE_APPROVED=yes/);
    });
    test(`${label}: budget must be within 1..50`, () => {
      for (const v of [undefined, "", "0", "-1", "51", "abc", "Infinity"])
        refuses({ ...env, SARVAM_SMOKE_BUDGET_INR: v }, /between 1 and 50/);
      for (const v of ["1", "50", "12.5"]) {
        const g = resolveSmokeGates({ ...env, SARVAM_SMOKE_BUDGET_INR: v }, ARGV, NODE);
        assert.ok(g.ok && g.budgetInr === Number(v), v);
      }
    });
    test(`${label}: OPENAI_LOG must be unset`, () => {
      refuses({ ...env, OPENAI_LOG: "debug" }, /unset OPENAI_LOG/);
    });
    test(`${label}: --out is required`, () => {
      refuses(env, /--out/, ["node", "x"]);
      refuses(env, /--out/, ["node", "x", "--out"]);
      refuses(env, /--out/, ["node", "x", "--out", "--other"]);
    });
  }
});

describe("smoke harness wiring", () => {
  test("the harness reads its gates (and the key) only through resolveSmokeGates", () => {
    const src = readFileSync(join(ROOT, "bench/sarvam-smoke.ts"), "utf8");
    assert.match(src, /resolveSmokeGates\(process\.env, process\.argv\)/);
    assert.ok(!/process\.env\.SARVAM_API_KEY/.test(src), "no direct SARVAM_API_KEY read");
    assert.ok(!/process\.env\.SARVAM_SMOKE_/.test(src), "no gate bypass");
  });

  // Refusing runs only: each lacks approval, budget and --out, the proxy points
  // at a closed local port, and the key is absent, so no request can be made.
  const spawnRefusal = (extra: Record<string, string>) => {
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"])
      if (process.env[k] !== undefined) env[k] = process.env[k]!;
    Object.assign(env, { HTTPS_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "1" }, extra);
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "bench/sarvam-smoke.ts"],
      { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 },
    );
  };
  test("process level: no approval -> exit 2 before anything else", () => {
    const r = spawnRefusal({});
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /refusing to run: this makes paid Sarvam calls/);
  });
  test("process level: proxy-injected with a local key -> exit 2", () => {
    const r = spawnRefusal({
      SARVAM_SMOKE_APPROVED: "yes",
      SARVAM_SMOKE_AUTH_MODE: "proxy-injected",
      SARVAM_API_KEY: "sk_spawn_canary_Zk3",
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /refusing to run: unset SARVAM_API_KEY/);
    assert.ok(!r.stderr.includes("sk_spawn_canary_Zk3"), "the key value is never printed");
  });
});
