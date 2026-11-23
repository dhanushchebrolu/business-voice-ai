import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The CI workflow's PostgreSQL setup. Run 44521771352 failed with exit code
 * 100 before any check ran: Ubuntu's mirrors returned 503 / timed out while
 * apt fetched the 18.6 kB `postgresql` meta-package, although the runner
 * image already ships the PostgreSQL 18 server the tests use. These checks
 * keep CI off that needless download without weakening the database tests.
 */
const workflow = readFileSync(
  new URL("../../.github/workflows/test.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const step = (name: string) => {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start > -1, `step "${name}" exists`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
};

describe("CI PostgreSQL setup", () => {
  test("a server already on the runner image is used; apt runs only when it is missing, with retries", () => {
    const install = step("Install PostgreSQL server");
    for (const bin of ["initdb", "pg_ctl", "psql"])
      assert.match(install, new RegExp(`compgen -G "/usr/lib/postgresql/\\*/bin/${bin}"`), bin);
    const guard = install.indexOf("compgen -G");
    const apt = install.indexOf("apt-get");
    assert.ok(guard > -1 && apt > guard, "apt is only reached through the else branch");
    assert.match(install, /else\n\s+sudo apt-get -o Acquire::Retries=5 update/);
    assert.match(install, /sudo apt-get -o Acquire::Retries=5 install -y postgresql/);
    assert.match(install, /set -eo pipefail/, "a failed install still fails the step");
    assert.match(install, /\/initdb" --version/, "the step proves a server is usable");
  });

  test("the database tests still run and still fail CI on any skip or todo", () => {
    const pg = step("PostgreSQL regression tests must not silently skip or todo in CI");
    // Every PostgreSQL file by glob, never a hand-kept list that new migrations fall out of.
    assert.match(pg, /--test --test-reporter=tap supabase\/migrations\/\*\.pg\.test\.ts/);
    // Only the PostgREST-binary skips are tolerated; any other skip still fails.
    assert.match(
      pg,
      /skipped=\$\(grep -E '# SKIP' pg-test-output\.log \| grep -vc 'POSTGREST_BIN' \|\| true\)/,
    );
    assert.match(pg, /if \[ "\$\{skipped:-0\}" -gt 0 \]; then[\s\S]*?exit 1/);
    assert.match(pg, /if \[ "\$\{todo:-0\}" -gt 0 \]; then[\s\S]*?exit 1/);
    // Setup comes before the tests that need it.
    assert.ok(
      workflow.indexOf("- name: Install PostgreSQL server") <
        workflow.indexOf("- name: PostgreSQL regression tests must not silently skip"),
    );
  });
});
