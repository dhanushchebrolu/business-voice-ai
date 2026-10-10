import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findPgBinDir, isRoot, postgresUserExists } from "./pg-test-cluster.ts";

/**
 * Harness self-test (not coverage of the real trigger — see
 * business_hours_interval_validation.pg.test.ts for that). This proves
 * that the skip-vs-fail logic in that file's pgTest()/before() correctly
 * turns "PostgreSQL is available but the SQL under test fails to load"
 * into a hard, nonzero-exit test failure — rather than the previous
 * behavior, where ANY before()-hook problem (including a genuinely
 * broken trigger) was folded into the same t.skip(reason) path and the
 * whole run exited 0 looking clean.
 *
 * This never modifies the committed migration file. It writes a
 * deliberately-broken SQL fixture and a tiny standalone test file to its
 * own throwaway temp directory, runs that file as a real `node --test`
 * child process against a real disposable PostgreSQL cluster (via the
 * same pg-test-cluster.ts bootstrap this repo's real suite uses), and
 * inspects the child's actual exit code and TAP output. Everything
 * written here is deleted in `after()`.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const pgTestClusterPath = join(migrationsDir, "pg-test-cluster.ts");

let skipReason: string | null = null;
let fixtureDir = "";

before(() => {
  // Only checks whether a real cluster COULD be bootstrapped here — does
  // not start one itself. The spawned child test below does its own
  // bootstrapCluster() independently, exercising the real path end to
  // end. If no PostgreSQL is available at all, there is no way to
  // distinguish "correctly failed" from "correctly skipped" here either,
  // so this self-test skips too, with the same honesty the real suite
  // applies to itself.
  const pgBinDir = findPgBinDir();
  if (!pgBinDir) {
    skipReason =
      "no PostgreSQL installation found — cannot exercise the real skip-vs-fail path without a real cluster";
    return;
  }
  if (isRoot()) {
    const userCheck = postgresUserExists();
    if (!userCheck.exists) {
      skipReason = `running as root and no usable 'postgres' OS user (${userCheck.detail})`;
      return;
    }
  }
  fixtureDir = mkdtempSync(join(tmpdir(), "bhv-harness-selftest-"));
});

after(() => {
  if (fixtureDir) {
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

const BROKEN_SQL_FIXTURE = `
CREATE OR REPLACE FUNCTION public.deliberately_broken_fixture()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN THIS IS NOT VALID SQL AND MUST FAIL TO LOAD;
END;
$$;
`;

describe("harness self-test — deliberately broken setup SQL must FAIL the suite, never skip it", () => {
  test("a fixture suite using the shared bootstrap+skip/fail pattern exits nonzero and reports a real failure when its setup SQL is broken", (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }

    const brokenSqlPath = join(fixtureDir, "broken.sql");
    writeFileSync(brokenSqlPath, BROKEN_SQL_FIXTURE, "utf8");

    const fixtureTestPath = join(fixtureDir, "fixture.pg.test.mts");
    writeFileSync(
      fixtureTestPath,
      [
        `import { test, before, after } from "node:test";`,
        `import assert from "node:assert/strict";`,
        `import { readFileSync } from "node:fs";`,
        `import { bootstrapCluster, makeExecSql, teardownCluster } from ${JSON.stringify(pgTestClusterPath)};`,
        ``,
        `let cluster = null;`,
        `let execSql = null;`,
        `let skipReason = null;`,
        `let setupFailure = null;`,
        ``,
        `before(() => {`,
        `  const result = bootstrapCluster();`,
        `  if (!result.ok) {`,
        `    skipReason = result.reason;`,
        `    return;`,
        `  }`,
        `  cluster = result.cluster;`,
        `  execSql = makeExecSql(cluster);`,
        `  const brokenSql = readFileSync(${JSON.stringify(brokenSqlPath)}, "utf8");`,
        `  const loadResult = execSql(brokenSql);`,
        `  if (loadResult.status !== 0) {`,
        `    setupFailure = "deliberately broken fixture failed to load: " + loadResult.stderr;`,
        `  }`,
        `});`,
        ``,
        `after(() => {`,
        `  if (cluster) teardownCluster(cluster);`,
        `});`,
        ``,
        `test("a test that would only run if setup had succeeded", (t) => {`,
        `  if (skipReason) { t.skip(skipReason); return; }`,
        `  if (setupFailure) { assert.fail(setupFailure); }`,
        `  assert.ok(true, "setup SQL loaded fine — this fixture is not exercising the failure path, which is itself a bug in this self-test");`,
        `});`,
      ].join("\n"),
      "utf8",
    );

    // NODE_TEST_CONTEXT is set by node:test on itself and inherited by
    // spawnSync's default environment; left in place, the child process
    // treats `--test` as a recursive nested call and silently runs
    // nothing (exit 0, no output) instead of actually executing the
    // fixture — which would make THIS self-test wrongly conclude the
    // broken-SQL case "passed" by never actually running it. Clearing it
    // makes the child a genuinely independent `node --test` invocation,
    // matching how it would run outside this self-test.
    const { NODE_TEST_CONTEXT, ...childEnv } = process.env;
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--test", fixtureTestPath],
      { encoding: "utf8", env: childEnv },
    );
    const combined = `${run.stdout}\n${run.stderr}`;

    assert.notEqual(
      run.status,
      0,
      `expected the fixture suite to exit nonzero when its setup SQL is genuinely broken, but got exit ${run.status}.\nOutput:\n${combined}`,
    );
    assert.match(
      combined,
      /not ok 1/,
      `expected the fixture test to be reported as a real TAP failure ('not ok'), not skipped.\nOutput:\n${combined}`,
    );
    assert.doesNotMatch(
      combined,
      /# SKIP/,
      `the broken-SQL case must never be reported as a skip — that is exactly the false-green bug this regression check guards against.\nOutput:\n${combined}`,
    );
    assert.match(
      combined,
      /deliberately broken fixture failed to load/,
      `expected the failure message to name the real cause (broken SQL), not a generic/misleading reason.\nOutput:\n${combined}`,
    );
  });
});
