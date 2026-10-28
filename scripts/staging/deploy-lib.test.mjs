import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  deployStaging,
  generatedConfigProblems,
  serverSecrets,
  STAGING_WORKER,
  wranglerDeployArgs,
} from "./deploy-lib.mjs";

/**
 * The staging deploy sequence with a fake command runner: nothing is built
 * or deployed. Checks the exact commands, the secrets file Wrangler gets,
 * that no value is ever printed, and that the temporary file is always
 * removed.
 */
const SECRET = "do-not-print-this-value";
const REQUIRED = ["SUPABASE_SERVICE_ROLE_KEY", "META_APP_SECRET", "LOVABLE_CRON_SECRET"];
const OPTIONAL = ["ANTHROPIC_API_KEY"];
const env = {
  SUPABASE_SERVICE_ROLE_KEY: `srv-${SECRET}`,
  META_APP_SECRET: `meta-${SECRET}`,
  LOVABLE_CRON_SECRET: `cron-${SECRET}`,
  VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  UNRELATED: `other-${SECRET}`,
};

/** A fake `run` that records calls and snapshots the secrets file Wrangler would read. */
function fakeRunner({ buildStatus = 0, deployStatus = 0, throwOnDeploy = false } = {}) {
  const calls = [];
  const run = (cmd, args, extraEnv) => {
    const call = { cmd, args: [...args], extraEnv: { ...extraEnv } };
    calls.push(call);
    if (args.includes("build")) return buildStatus;
    const i = args.indexOf("--secrets-file");
    call.secretsFile = args[i + 1];
    call.secretsFileExisted = existsSync(call.secretsFile);
    call.secretsJson = JSON.parse(readFileSync(call.secretsFile, "utf8"));
    if (throwOnDeploy) throw new Error("wrangler crashed");
    return deployStatus;
  };
  return { calls, run };
}

function deploy(overrides = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "deploy-lib-test-"));
  const logs = [];
  const runner = overrides.runner ?? fakeRunner();
  let error = null;
  let result = null;
  try {
    result = deployStaging({
      env: overrides.env ?? env,
      required: REQUIRED,
      optional: OPTIONAL,
      buildEnv: { VITE_SUPABASE_URL: env.VITE_SUPABASE_URL },
      run: runner.run,
      readGeneratedConfig: () => overrides.generated ?? { name: STAGING_WORKER },
      tmpRoot,
      log: (line) => logs.push(line),
    });
  } catch (err) {
    error = err;
  }
  const leftovers = readdirSync(tmpRoot);
  rmSync(tmpRoot, { recursive: true, force: true });
  return { calls: runner.calls, logs, error, result, leftovers };
}

test("builds for staging, then deploys clickai-staging with a secrets file", () => {
  const { calls, error, leftovers } = deploy();
  assert.equal(error, null);
  assert.equal(calls.length, 2);
  const [build, wrangler] = calls;
  assert.deepEqual(build.args, ["--no-install", "vite", "build"]);
  assert.equal(build.extraEnv.CLICKAI_DEPLOY_TARGET, "staging");
  assert.equal(build.extraEnv.VITE_SUPABASE_URL, env.VITE_SUPABASE_URL);
  assert.deepEqual(wrangler.args, [
    "--no-install",
    "wrangler",
    "deploy",
    "--name",
    "clickai-staging",
    "--secrets-file",
    wrangler.secretsFile,
  ]);
  assert.ok(wrangler.secretsFileExisted, "the file exists while Wrangler runs");
  assert.ok(!existsSync(wrangler.secretsFile), "and is gone afterwards");
  assert.ok(!existsSync(dirname(wrangler.secretsFile)), "with its private directory");
  assert.deepEqual(leftovers, []);
});

test("the secrets file holds exactly the required secrets plus the optional ones that are set", () => {
  const without = deploy().calls[1].secretsJson;
  assert.deepEqual(Object.keys(without).sort(), [...REQUIRED].sort());
  assert.equal(without.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(without.UNRELATED, undefined, "nothing but server secrets");
  assert.equal(without.VITE_SUPABASE_URL, undefined, "public build values aren't secrets");
  const withOptional = deploy({ env: { ...env, ANTHROPIC_API_KEY: `ai-${SECRET}` } }).calls[1]
    .secretsJson;
  assert.deepEqual(Object.keys(withOptional).sort(), [...REQUIRED, ...OPTIONAL].sort());
});

test("no secret value is ever printed or passed on the command line", () => {
  const { calls, logs } = deploy();
  assert.match(logs.join("\n"), /deployed clickai-staging with 3 secrets .*values not shown/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET));
  for (const call of calls) {
    assert.doesNotMatch(JSON.stringify(call.args), new RegExp(SECRET), call.args.join(" "));
  }
});

test("the temporary file is removed when Wrangler fails or throws", () => {
  for (const runner of [fakeRunner({ deployStatus: 1 }), fakeRunner({ throwOnDeploy: true })]) {
    const { calls, error, leftovers } = deploy({ runner });
    assert.ok(error, "the failure is reported");
    assert.ok(calls[1].secretsFileExisted);
    assert.ok(!existsSync(calls[1].secretsFile));
    assert.deepEqual(leftovers, []);
    assert.doesNotMatch(String(error.message), new RegExp(SECRET));
  }
});

test("a build that isn't clickai-staging — klyro included — is never deployed, and no secrets file is written", () => {
  for (const generated of [{ name: "klyro" }, { name: "something-else" }, {}]) {
    const { calls, error, leftovers } = deploy({ generated });
    assert.match(String(error?.message), /not clickai-staging/);
    assert.equal(calls.length, 1, "only the build ran");
    assert.deepEqual(leftovers, []);
  }
  const failedBuild = deploy({ runner: fakeRunner({ buildStatus: 2 }) });
  assert.match(String(failedBuild.error?.message), /vite build exited with 2/);
  assert.equal(failedBuild.calls.length, 1);
});

test("a clickai-staging config with routes, environments or production references is never deployed", () => {
  for (const [generated, message] of [
    [{ name: STAGING_WORKER, routes: [{ pattern: "app.example.com/*" }] }, /sets "routes"/],
    [{ name: STAGING_WORKER, route: "app.example.com/*" }, /sets "route"/],
    [{ name: STAGING_WORKER, env: { production: {} } }, /sets "env"/],
    [
      { name: STAGING_WORKER, vars: { SUPABASE_URL: "https://eorazvlmqwunmhwviocn.supabase.co" } },
      /production project/,
    ],
    [
      { name: STAGING_WORKER, vars: { TELEPHONY_WEBHOOK_BASE_URL: "https://klyro.x.workers.dev" } },
      /production Worker klyro/,
    ],
  ]) {
    const { calls, error, leftovers } = deploy({ generated });
    assert.match(String(error?.message), message);
    assert.equal(calls.length, 1, "only the build ran");
    assert.deepEqual(leftovers, [], "no secrets file was written");
  }
  assert.deepEqual(generatedConfigProblems({ name: STAGING_WORKER, main: "index.mjs" }), []);
});

test("a missing required secret stops before anything is built", () => {
  const { calls, error } = deploy({ env: { ...env, META_APP_SECRET: "" } });
  assert.match(String(error?.message), /missing server secrets: META_APP_SECRET/);
  assert.equal(calls.length, 0);
  assert.throws(() => serverSecrets({}, ["A"], []), /missing server secrets: A/);
});

test("the deploy arguments always name clickai-staging", () => {
  const args = wranglerDeployArgs("/tmp/x/secrets.json");
  assert.equal(args[args.indexOf("--name") + 1], "clickai-staging");
  assert.ok(!args.includes("klyro"));
});
