import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapCluster,
  makeExecSql,
  registerSignalCleanup,
  teardownCluster,
  type Cluster,
  type RunResult,
} from "./pg-test-cluster.ts";

/**
 * Executable regression coverage for the business_hours/business_hour_
 * overrides interval-validation trigger, run against a REAL, disposable
 * PostgreSQL instance created and torn down by this file (via
 * pg-test-cluster.ts) — not a source-text scan. Supplements
 * business_hours_interval_validation.test.ts (which still pins the SQL's
 * own structural invariants and runs even where no PostgreSQL is
 * available) rather than replacing it.
 *
 * This never touches any shared or production database: it initializes
 * a brand-new cluster in a throwaway temp directory, communicates only
 * over a Unix-domain socket inside that same directory, and deletes
 * everything in `after()`.
 *
 * Skip vs. fail (the false-green bug this file previously had): if
 * PostgreSQL genuinely cannot be stood up in this environment (missing
 * binaries, no `postgres` OS user to de-escalate to as root, a failed
 * initdb/pg_ctl start) every test below is explicitly SKIPPED via
 * `t.skip(reason)`. But once the cluster is confirmed up and listening,
 * PostgreSQL IS available — so if the committed trigger migration itself
 * then fails to load, that is a real regression, and every test below
 * FAILS instead (via `assert.fail`), never skips. See
 * business_hours_interval_validation.harness-selftest.pg.test.ts for a
 * standalone regression check proving this distinction holds, using a
 * deliberately-broken fixture that never touches this committed
 * migration file.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const TRIGGER_SQL = readFileSync(
  join(migrationsDir, "20261010100000_business_hours_interval_validation.sql"),
  "utf8",
);

let cluster: Cluster | null = null;
let execSql: (sql: string) => RunResult = () => {
  throw new Error("execSql used before before() finished setting up the cluster");
};
let unregisterSignalCleanup: (() => void) | null = null;

/** Genuine infrastructure unavailability (no PostgreSQL, no postgres OS user, cluster start failed) — a skip is correct for these. */
let skipReason: string | null = null;
/** PostgreSQL IS up and available, but SQL this file tried to load into it failed — this must FAIL the suite, never skip. */
let setupFailure: string | null = null;

function execSqlDynamic(sql: string): RunResult {
  return execSql(sql);
}

function assertSucceeds(sql: string, message: string) {
  const { status, stderr } = execSqlDynamic(sql);
  assert.equal(status, 0, `${message}\nSQL:\n${sql}\nstderr:\n${stderr}`);
}

function assertRejected(sql: string, expectedSubstring: string, message: string) {
  const { status, stderr } = execSqlDynamic(sql);
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
  const { status, stdout, stderr } = execSqlDynamic(`\\pset tuples_only on\n${sql}`);
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
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregisterSignalCleanup = registerSignalCleanup(() => cluster);

  // PostgreSQL is now definitively available — neither failure below is
  // an infrastructure gap, so both are recorded as setupFailure (hard
  // failure via pgTest()) rather than skipReason (skip).
  const schemaResult = execSql(MINIMAL_SCHEMA);
  if (schemaResult.status !== 0) {
    setupFailure = `failed to create the minimal test schema: ${schemaResult.stderr}`;
    return;
  }

  const triggerResult = execSql(TRIGGER_SQL);
  if (triggerResult.status !== 0) {
    setupFailure = `failed to load the trigger migration SQL as-committed: ${triggerResult.stderr}`;
    return;
  }
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

function pgTest(name: string, fn: () => void) {
  test(name, (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    if (setupFailure) {
      assert.fail(
        `PostgreSQL is available, but setup SQL failed to load into the disposable cluster — this is a real failure, not a skip: ${setupFailure}`,
      );
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

  pgTest(
    "an open row with an empty intervals array is accepted ('open, nothing configured yet')",
    () => {
      assertSucceeds(
        `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[]'::jsonb);`,
        "an empty array on an open row is a real, distinct state, not an error",
      );
    },
  );

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

describe("business_hours — real PostgreSQL: malformed JSON shapes (committed regression coverage)", () => {
  pgTest("intervals as a JSON string (not an array) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '"not an array"'::jsonb);`,
      "must be a JSON array (got string)",
      "a non-array JSON string must be rejected with the correct observed type",
    );
  });

  pgTest("intervals as a JSON number is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '5'::jsonb);`,
      "must be a JSON array (got number)",
      "a bare JSON number must be rejected",
    );
  });

  pgTest("intervals as a JSON object (not an array) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '{}'::jsonb);`,
      "must be a JSON array (got object)",
      "a bare JSON object must be rejected",
    );
  });

  pgTest("intervals as the JSON literal null (distinct from SQL NULL) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, 'null'::jsonb);`,
      "must be a JSON array (got null)",
      "the JSON null literal must still be rejected for an open row, unlike a true SQL NULL",
    );
  });

  pgTest("intervals as a JSON boolean is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, 'true'::jsonb);`,
      "must be a JSON array (got boolean)",
      "a bare JSON boolean must be rejected",
    );
  });

  pgTest("an array element that is a string (not an object) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '["not an object"]'::jsonb);`,
      "interval 1 must be a JSON object (got string)",
      "each array element must itself be a JSON object",
    );
  });

  pgTest("an array element that is a number is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[5]'::jsonb);`,
      "interval 1 must be a JSON object (got number)",
      "a numeric array element must be rejected",
    );
  });

  pgTest("an array element that is itself an array is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[[]]'::jsonb);`,
      "interval 1 must be a JSON object (got array)",
      "a nested-array element must be rejected",
    );
  });

  pgTest("an array element that is the JSON literal null is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[null]'::jsonb);`,
      "interval 1 must be a JSON object (got null)",
      "a null array element must be rejected",
    );
  });

  pgTest("an object missing the 'start' key entirely is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"end":"19:00"}]'::jsonb);`,
      'interval 1 is missing a string "start"',
      "a missing start key must be rejected",
    );
  });

  pgTest("an object with 'start' as a non-string (number) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":900,"end":"19:00"}]'::jsonb);`,
      'interval 1 is missing a string "start"',
      "a numeric start must be rejected the same way a missing one is",
    );
  });

  pgTest("an object missing the 'end' key entirely is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00"}]'::jsonb);`,
      'interval 1 is missing a string "end"',
      "a missing end key must be rejected",
    );
  });

  pgTest("an object with 'end' as a non-string (boolean) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00","end":true}]'::jsonb);`,
      'interval 1 is missing a string "end"',
      "a boolean end must be rejected the same way a missing one is",
    );
  });

  pgTest("a malformed start time (single-digit hour) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"9:00","end":"19:00"}]'::jsonb);`,
      "interval 1 has a malformed start time",
      "a non-zero-padded hour must be rejected",
    );
  });

  pgTest("a malformed end time (out-of-range minutes) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00","end":"19:60"}]'::jsonb);`,
      "interval 1 has a malformed end time",
      "an out-of-range minute value must be rejected",
    );
  });

  pgTest("the second element's index is reported correctly when the first element is valid", () => {
    assertRejected(
      `INSERT INTO business_hours (is_closed, intervals) VALUES (false, '[{"start":"09:00","end":"12:00"},{"start":"20:00","end":"10:00"}]'::jsonb);`,
      "interval 2 end",
      "the 1-based index in the error must point at the actually-invalid element, not always the first",
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

  pgTest("an override interval with isOpen as a non-boolean (string) is rejected", () => {
    assertRejected(
      `INSERT INTO business_hour_overrides (is_full_day_closure, intervals) VALUES (false, '[{"start":"10:00","end":"11:00","isOpen":"true"}]'::jsonb);`,
      'override interval 1 is missing a boolean "isOpen"',
      "a string isOpen must be rejected the same way a missing one is",
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
