import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * Executable regression coverage for the business_hours/business_hour_
 * overrides interval-validation trigger, run against a REAL, disposable
 * PostgreSQL instance created and torn down by this file — not a source-
 * text scan. Supplements business_hours_interval_validation.test.ts
 * (which still pins the SQL's own structural invariants and runs even
 * where no PostgreSQL is available) rather than replacing it.
 *
 * This never touches any shared or production database: it initializes
 * a brand-new cluster in a throwaway temp directory, communicates only
 * over a Unix-domain socket inside that same directory, and deletes
 * everything in `after()`.
 *
 * Environment detection: `initdb` refuses to run as root, so when this
 * process IS root (true in some sandboxed CI/dev containers) the suite
 * instead runs every psql/initdb/pg_ctl invocation as the unprivileged
 * `postgres` OS user via `su postgres -c '...'`, matching how this was
 * verified interactively during development. If neither a usable
 * PostgreSQL installation nor (when needed) a `postgres` OS user can be
 * found, every test below is explicitly SKIPPED via `t.skip(reason)` —
 * reported distinctly from pass/fail by the test runner — rather than
 * silently vanishing or being reported as a false pass.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const TRIGGER_SQL = readFileSync(
  join(migrationsDir, "20261010100000_business_hours_interval_validation.sql"),
  "utf8",
);

let workDir = "";
let sockDir = "";
let dataDir = "";
let pgBinDir = "";
let useSu = false;
let skipReason: string | null = null;

function findPgBinDir(): string | null {
  const candidates = [
    "",
    "/usr/lib/postgresql/17/bin/",
    "/usr/lib/postgresql/16/bin/",
    "/usr/lib/postgresql/15/bin/",
    "/usr/lib/postgresql/14/bin/",
    "/opt/homebrew/opt/postgresql@16/bin/",
    "/usr/local/opt/postgresql@16/bin/",
  ];
  for (const dir of candidates) {
    try {
      execFileSync(`${dir}psql`, ["--version"], { stdio: "ignore" });
      execFileSync(`${dir}initdb`, ["--version"], { stdio: "ignore" });
      return dir;
    } catch {
      continue;
    }
  }
  return null;
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function postgresUserExists(): boolean {
  const result = spawnSync("id", ["postgres"], { stdio: "ignore" });
  return result.status === 0;
}

/** Runs a shell command either directly, or as the `postgres` OS user when this process is root. */
function runCmd(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = useSu
    ? spawnSync("su", ["postgres", "-c", [cmd, ...args].join(" ")], { encoding: "utf8" })
    : spawnSync(cmd, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Pipes `sql` on stdin to psql against the disposable cluster. Returns the exit status and captured output. */
function execSql(sql: string): { status: number; stdout: string; stderr: string } {
  const args = ["-h", sockDir, "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-X", "-f", "-"];
  const result = useSu
    ? spawnSync("su", ["postgres", "-c", [`${pgBinDir}psql`, ...args].join(" ")], {
        input: sql,
        encoding: "utf8",
      })
    : spawnSync(`${pgBinDir}psql`, args, { input: sql, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertSucceeds(sql: string, message: string) {
  const { status, stderr } = execSql(sql);
  assert.equal(status, 0, `${message}\nSQL:\n${sql}\nstderr:\n${stderr}`);
}

function assertRejected(sql: string, expectedSubstring: string, message: string) {
  const { status, stderr } = execSql(sql);
  assert.notEqual(
    status,
    0,
    `${message} (expected a rejection, but the statement succeeded)\nSQL:\n${sql}`,
  );
  assert.ok(
    stderr.includes(expectedSubstring),
    `${message}\nExpected stderr to include "${expectedSubstring}"\nActual stderr:\n${stderr}`,
  );
}

function scalar(sql: string): string {
  const { status, stdout, stderr } = execSql(`\\pset tuples_only on\n${sql}`);
  assert.equal(status, 0, `query failed:\n${sql}\nstderr:\n${stderr}`);
  return stdout.trim();
}

const MINIMAL_SCHEMA = `
CREATE TABLE business_hours (
  id SERIAL PRIMARY KEY,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE business_hour_overrides (
  id SERIAL PRIMARY KEY,
  is_full_day_closure BOOLEAN NOT NULL DEFAULT false,
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT
);
`;

before(() => {
  const found = findPgBinDir();
  if (!found) {
    skipReason =
      "no PostgreSQL installation (psql/initdb) found on PATH or in common install locations";
    return;
  }
  pgBinDir = found;

  if (isRoot()) {
    if (!postgresUserExists()) {
      skipReason = "running as root and no 'postgres' OS user exists to run initdb/psql as";
      return;
    }
    useSu = true;
  }

  workDir = mkdtempSync(join(tmpdir(), "bhv-pg-test-"));
  dataDir = join(workDir, "data");
  sockDir = join(workDir, "sock");

  // Created directly by this (possibly root) process, not via runCmd/su —
  // the postgres OS user doesn't yet have any access to workDir at this
  // point, so it couldn't create subdirectories here even if asked to.
  // chmod + chown below hand the whole tree over before postgres touches
  // anything in it.
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sockDir, { recursive: true });
  chmodSync(workDir, 0o755);
  if (useSu) {
    const chownResult = spawnSync("chown", ["-R", "postgres:postgres", workDir], {
      encoding: "utf8",
    });
    if (chownResult.status !== 0) {
      skipReason = `could not chown the disposable cluster directory to postgres: ${chownResult.stderr}`;
      return;
    }
  }

  const initResult = runCmd(`${pgBinDir}initdb`, ["-D", dataDir, "--auth=trust", "-U", "postgres"]);
  if (initResult.status !== 0) {
    skipReason = `initdb failed: ${initResult.stderr}`;
    return;
  }

  const startResult = runCmd(`${pgBinDir}pg_ctl`, [
    "-D",
    dataDir,
    "-o",
    `"-k ${sockDir} -h ''"`,
    "-l",
    join(workDir, "log.txt"),
    "start",
  ]);
  if (startResult.status !== 0) {
    skipReason = `pg_ctl start failed: ${startResult.stderr}`;
    return;
  }

  const schemaResult = execSql(MINIMAL_SCHEMA);
  if (schemaResult.status !== 0) {
    skipReason = `failed to create the minimal test schema: ${schemaResult.stderr}`;
    return;
  }

  const triggerResult = execSql(TRIGGER_SQL);
  if (triggerResult.status !== 0) {
    skipReason = `failed to load the trigger migration SQL as-committed: ${triggerResult.stderr}`;
    return;
  }
});

after(() => {
  if (!workDir) return;
  runCmd(`${pgBinDir}pg_ctl`, ["-D", dataDir, "stop", "-m", "immediate"]);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best effort — a leftover /tmp directory is not worth failing the suite over
  }
});

function pgTest(name: string, fn: () => void) {
  test(name, (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    fn();
  });
}

describe("business_hours — real PostgreSQL: INSERT", () => {
  pgTest("a valid open interval is accepted", () => {
    assertSucceeds(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00","end":"19:00"}]'::jsonb);`,
      "a well-formed open interval must be accepted",
    );
  });

  pgTest("the 00:00 -> 23:59 all-day convention is accepted", () => {
    assertSucceeds(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"00:00","end":"23:59"}]'::jsonb);`,
      "the established all-day convention must be accepted",
    );
  });

  pgTest("a reversed interval (23:59 -> 00:00, the known legacy-invalid shape) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"23:59","end":"00:00"}]'::jsonb);`,
      "INVALID_BUSINESS_HOURS_INTERVAL",
      "a reversed interval must be rejected on INSERT",
    );
  });

  pgTest("equal start and end is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00","end":"09:00"}]'::jsonb);`,
      "INVALID_BUSINESS_HOURS_INTERVAL",
      "equal start/end must be rejected",
    );
  });

  pgTest("a closed row with the same invalid shape is accepted (closed-row bypass)", () => {
    assertSucceeds(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (true, '[{"start":"23:59","end":"00:00"}]'::jsonb);`,
      "a closed row's intervals must never be validated, regardless of content",
    );
  });
});

describe("business_hours — real PostgreSQL: UPDATE", () => {
  pgTest("changing intervals on an already-open, valid row to a new valid value succeeds", () => {
    const id = scalar(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00","end":"17:00"}]'::jsonb) RETURNING id;`,
    );
    assertSucceeds(
      `UPDATE business_hours SET intervals = '[{"start":"10:00","end":"18:00"}]'::jsonb WHERE id = ${id};`,
      "a legitimate interval edit on a valid row must still succeed",
    );
  });

  pgTest(
    "changing intervals on an already-open, valid row to a new invalid value is rejected",
    () => {
      const id = scalar(
        `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00","end":"17:00"}]'::jsonb) RETURNING id;`,
      );
      assertRejected(
        `UPDATE business_hours SET intervals = '[{"start":"18:00","end":"10:00"}]'::jsonb WHERE id = ${id};`,
        "INVALID_BUSINESS_HOURS_INTERVAL",
        "introducing an invalid interval via UPDATE must still be rejected",
      );
    },
  );

  pgTest(
    "an UPDATE to an unrelated column on an existing OPEN row with legacy-invalid intervals succeeds (the fix under review)",
    () => {
      // Seed exactly the shape a pre-existing, pre-trigger row has: disable
      // the trigger, write the bad data directly, re-enable it — this is
      // what "data written before this trigger existed" actually looks
      // like, not something achievable through a normal INSERT once the
      // trigger is active.
      assertSucceeds(
        `ALTER TABLE business_hours DISABLE TRIGGER trg_business_hours_validate_intervals;`,
        "must be able to disable the trigger to seed legacy data",
      );
      const id = scalar(
        `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"23:59","end":"00:00"}]'::jsonb) RETURNING id;`,
      );
      assertSucceeds(
        `ALTER TABLE business_hours ENABLE TRIGGER trg_business_hours_validate_intervals;`,
        "must be able to re-enable the trigger",
      );

      assertSucceeds(
        `UPDATE business_hours SET updated_at = now() WHERE id = ${id};`,
        "an update that touches neither is_closed nor intervals must not be blocked by this row's pre-existing invalid intervals",
      );

      // jsonb does not preserve input key order (unlike json), so compare
      // the extracted field values rather than the serialized text.
      const unchanged = scalar(
        `SELECT (intervals = '[{"start":"23:59","end":"00:00"}]'::jsonb)::text FROM business_hours WHERE id = ${id};`,
      );
      assert.equal(
        unchanged,
        "true",
        "the legacy-invalid intervals must be left exactly as they were — this trigger never repairs or backfills data",
      );
    },
  );

  pgTest(
    "closing an existing OPEN row with legacy-invalid intervals succeeds (closed-row bypass still applies on UPDATE)",
    () => {
      assertSucceeds(
        `ALTER TABLE business_hours DISABLE TRIGGER trg_business_hours_validate_intervals;`,
        "disable",
      );
      const id = scalar(
        `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"23:59","end":"00:00"}]'::jsonb) RETURNING id;`,
      );
      assertSucceeds(
        `ALTER TABLE business_hours ENABLE TRIGGER trg_business_hours_validate_intervals;`,
        "enable",
      );

      assertSucceeds(
        `UPDATE business_hours SET is_closed = true, intervals = '[]'::jsonb WHERE id = ${id};`,
        "closing a row must always succeed regardless of its prior intervals",
      );
    },
  );

  pgTest(
    "reopening that same row WITHOUT fixing its intervals is rejected (closure-flag changed -> re-validates)",
    () => {
      assertSucceeds(
        `ALTER TABLE business_hours DISABLE TRIGGER trg_business_hours_validate_intervals;`,
        "disable",
      );
      const id = scalar(
        `INSERT INTO business_hours (is_closed, intervals) VALUES (true, '[{"start":"23:59","end":"00:00"}]'::jsonb) RETURNING id;`,
      );
      assertSucceeds(
        `ALTER TABLE business_hours ENABLE TRIGGER trg_business_hours_validate_intervals;`,
        "enable",
      );

      // is_closed is changing (true -> false) even though intervals in the
      // SET clause is unchanged text — this must NOT be treated as "nothing
      // relevant changed", or a row could be silently reopened with
      // garbage data.
      assertRejected(
        `UPDATE business_hours SET is_closed = false WHERE id = ${id};`,
        "INVALID_BUSINESS_HOURS_INTERVAL",
        "reopening a row must re-validate its existing intervals, since the closed-flag itself changed",
      );
    },
  );

  pgTest("reopening with corrected intervals in the same statement succeeds", () => {
    assertSucceeds(
      `ALTER TABLE business_hours DISABLE TRIGGER trg_business_hours_validate_intervals;`,
      "disable",
    );
    const id = scalar(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (true, '[{"start":"23:59","end":"00:00"}]'::jsonb) RETURNING id;`,
    );
    assertSucceeds(
      `ALTER TABLE business_hours ENABLE TRIGGER trg_business_hours_validate_intervals;`,
      "enable",
    );

    assertSucceeds(
      `UPDATE business_hours SET is_closed = false, intervals = '[{"start":"09:00","end":"19:00"}]'::jsonb WHERE id = ${id};`,
      "reopening with a corrected interval in the same statement must succeed",
    );
  });

  pgTest(
    "re-running the exact same UPDATE twice (a no-op resubmission) does not re-validate the second time",
    () => {
      const id = scalar(
        `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00","end":"17:00"}]'::jsonb) RETURNING id;`,
      );
      const sameUpdate = `UPDATE business_hours SET intervals = '[{"start":"09:00","end":"17:00"}]'::jsonb WHERE id = ${id};`;
      assertSucceeds(sameUpdate, "first application");
      assertSucceeds(
        sameUpdate,
        "idempotent resubmission of the identical, already-valid value must also succeed",
      );
    },
  );
});

describe("business_hour_overrides — real PostgreSQL: INSERT", () => {
  pgTest("a valid override interval with isOpen is accepted", () => {
    assertSucceeds(
      `INSERT INTO business_hour_overrides (is_full_day_closure, intervals) VALUES (false, '[{"start":"10:00","end":"11:00","isOpen":true}]'::jsonb);`,
      "a well-formed override interval must be accepted",
    );
  });

  pgTest("a reversed override interval is rejected", () => {
    assertRejected(
      `INSERT INTO business_hour_overrides (is_full_day_closure, intervals) VALUES (false, '[{"start":"23:59","end":"00:00","isOpen":true}]'::jsonb);`,
      "INVALID_BUSINESS_HOURS_INTERVAL",
      "a reversed override interval must be rejected",
    );
  });

  pgTest("an override interval missing isOpen is rejected", () => {
    assertRejected(
      `INSERT INTO business_hour_overrides (is_full_day_closure, intervals) VALUES (false, '[{"start":"10:00","end":"11:00"}]'::jsonb);`,
      "INVALID_BUSINESS_HOURS_INTERVAL",
      "a missing isOpen key must be rejected",
    );
  });

  pgTest(
    "a full-day-closure override with an invalid interval anyway is accepted (closed-row bypass)",
    () => {
      assertSucceeds(
        `INSERT INTO business_hour_overrides (is_full_day_closure, intervals) VALUES (true, '[{"start":"23:59","end":"00:00"}]'::jsonb);`,
        "a full-day-closure row's intervals must never be validated",
      );
    },
  );
});

describe("business_hour_overrides — real PostgreSQL: UPDATE", () => {
  pgTest(
    "an UPDATE to an unrelated column (reason) on a legacy-invalid, non-closed override succeeds",
    () => {
      assertSucceeds(
        `ALTER TABLE business_hour_overrides DISABLE TRIGGER trg_business_hour_overrides_validate_intervals;`,
        "disable",
      );
      const id = scalar(
        `INSERT INTO business_hour_overrides (is_full_day_closure, intervals) VALUES (false, '[{"start":"23:59","end":"00:00"}]'::jsonb) RETURNING id;`,
      );
      assertSucceeds(
        `ALTER TABLE business_hour_overrides ENABLE TRIGGER trg_business_hour_overrides_validate_intervals;`,
        "enable",
      );

      assertSucceeds(
        `UPDATE business_hour_overrides SET reason = 'holiday' WHERE id = ${id};`,
        "an update that touches neither is_full_day_closure nor intervals must not be blocked",
      );
    },
  );

  pgTest("marking that same legacy-invalid override as a full-day closure succeeds", () => {
    assertSucceeds(
      `ALTER TABLE business_hour_overrides DISABLE TRIGGER trg_business_hour_overrides_validate_intervals;`,
      "disable",
    );
    const id = scalar(
      `INSERT INTO business_hour_overrides (is_full_day_closure, intervals) VALUES (false, '[{"start":"23:59","end":"00:00"}]'::jsonb) RETURNING id;`,
    );
    assertSucceeds(
      `ALTER TABLE business_hour_overrides ENABLE TRIGGER trg_business_hour_overrides_validate_intervals;`,
      "enable",
    );

    assertSucceeds(
      `UPDATE business_hour_overrides SET is_full_day_closure = true, intervals = '[]'::jsonb WHERE id = ${id};`,
      "closing an override must always succeed regardless of its prior intervals",
    );
  });

  pgTest("un-closing it again without fixing intervals is rejected", () => {
    assertSucceeds(
      `ALTER TABLE business_hour_overrides DISABLE TRIGGER trg_business_hour_overrides_validate_intervals;`,
      "disable",
    );
    const id = scalar(
      `INSERT INTO business_hour_overrides (is_full_day_closure, intervals) VALUES (true, '[{"start":"23:59","end":"00:00"}]'::jsonb) RETURNING id;`,
    );
    assertSucceeds(
      `ALTER TABLE business_hour_overrides ENABLE TRIGGER trg_business_hour_overrides_validate_intervals;`,
      "enable",
    );

    assertRejected(
      `UPDATE business_hour_overrides SET is_full_day_closure = false WHERE id = ${id};`,
      "INVALID_BUSINESS_HOURS_INTERVAL",
      "re-opening the override must re-validate its existing intervals",
    );
  });
});
