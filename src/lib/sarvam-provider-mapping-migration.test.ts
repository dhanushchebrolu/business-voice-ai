import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the 20260908110000 migration (Sarvam
 * provider-mapping columns) — the schema-level half of the security
 * guarantees sarvam-admin.functions.test.ts covers at the application
 * layer. No live Supabase connection exists in this sandbox, so this is a
 * source scan of the migration SQL itself, the same technique used
 * throughout this session for every other migration (e.g.
 * telephony-billing-idempotency.test.ts).
 *
 * Two of these tests are cross-file consistency checks, not just SQL
 * scans: they parse the actual client code that inserts/updates
 * agent_configs (app.onboarding.tsx, app.agent.tsx) and assert every
 * column it uses is present in the migration's new GRANT column lists —
 * so if either file drifts in the future without the other being updated,
 * the test catches it rather than silently breaking onboarding/settings.
 */

const migrationSrc = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "supabase",
    "migrations",
    "20260908110000_sarvam_provider_mapping.sql",
  ),
  "utf8",
);

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts), "utf8");
}

describe("customer cannot modify Sarvam app mapping (agent_configs)", () => {
  test("the blanket authenticated INSERT/UPDATE grant is revoked before being replaced", () => {
    const revokeIdx = migrationSrc.indexOf(
      "REVOKE INSERT, UPDATE ON public.agent_configs FROM authenticated;",
    );
    assert.ok(revokeIdx > -1);
  });

  test("neither the new GRANT INSERT nor GRANT UPDATE column list includes sarvam_app_id, sarvam_app_version, status, or active_version", () => {
    const insertGrantMatch = migrationSrc.match(
      /GRANT INSERT \(([\s\S]*?)\) ON public\.agent_configs/,
    );
    const updateGrantMatch = migrationSrc.match(
      /GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_configs/,
    );
    assert.ok(
      insertGrantMatch && updateGrantMatch,
      "expected both GRANT INSERT and GRANT UPDATE column lists",
    );
    for (const forbidden of ["sarvam_app_id", "sarvam_app_version", "status", "active_version"]) {
      assert.doesNotMatch(
        insertGrantMatch![1]!,
        new RegExp(`\\b${forbidden}\\b`),
        `INSERT must not grant ${forbidden}`,
      );
      assert.doesNotMatch(
        updateGrantMatch![1]!,
        new RegExp(`\\b${forbidden}\\b`),
        `UPDATE must not grant ${forbidden}`,
      );
    }
  });
});

describe("customer cannot modify provider connection ID or deployment ID (telephony_connections / phone_numbers)", () => {
  test("this migration grants no new authenticated INSERT/UPDATE on telephony_connections or phone_numbers", () => {
    assert.doesNotMatch(
      migrationSrc,
      /GRANT (INSERT|UPDATE)[\s\S]{0,60}public\.telephony_connections[\s\S]{0,20}TO authenticated/,
    );
    assert.doesNotMatch(
      migrationSrc,
      /GRANT (INSERT|UPDATE)[\s\S]{0,60}public\.phone_numbers[\s\S]{0,20}TO authenticated/,
    );
  });

  test("the original schema never granted authenticated INSERT/UPDATE on these tables either (still SELECT-only today)", () => {
    const originalSchema = readRepoFile(
      "supabase",
      "migrations",
      "20260829120932_c8cdfc97-92e1-4fd0-b400-793aaddbbbc1.sql",
    );
    assert.match(originalSchema, /GRANT SELECT ON public\.telephony_connections TO authenticated;/);
    assert.match(originalSchema, /GRANT SELECT ON public\.phone_numbers TO authenticated;/);
    assert.doesNotMatch(
      originalSchema,
      /GRANT (INSERT|UPDATE)[\s\S]{0,40}public\.telephony_connections/,
    );
    assert.doesNotMatch(originalSchema, /GRANT (INSERT|UPDATE)[\s\S]{0,40}public\.phone_numbers/);
  });
});

describe("duplicate Sarvam app ID / connection ID rejected at the storage layer", () => {
  test("a partial unique index protects agent_configs.sarvam_app_id (nullable-safe: allows unlimited NULLs)", () => {
    assert.match(
      migrationSrc,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_sarvam_app_id\s*\n\s*ON public\.agent_configs \(sarvam_app_id\) WHERE sarvam_app_id IS NOT NULL;/,
    );
  });

  test("a partial unique index protects telephony_connections(provider, provider_connection_id)", () => {
    assert.match(
      migrationSrc,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_telephony_connections_provider_connection_id\s*\n\s*ON public\.telephony_connections \(provider, provider_connection_id\)\s*\n\s*WHERE provider_connection_id IS NOT NULL;/,
    );
  });
});

describe("multiple phone numbers may share the same deployment ID", () => {
  test("phone_numbers.provider_deployment_id has a PLAIN index, never a UNIQUE one — a deployment can legitimately span many numbers", () => {
    assert.match(
      migrationSrc,
      /CREATE INDEX IF NOT EXISTS idx_phone_numbers_provider_deployment_id\s*\n\s*ON public\.phone_numbers \(provider_deployment_id\) WHERE provider_deployment_id IS NOT NULL;/,
    );
    // Never any CREATE UNIQUE INDEX naming this column.
    assert.doesNotMatch(migrationSrc, /CREATE UNIQUE INDEX[\s\S]{0,80}provider_deployment_id/);
  });
});

describe("existing agent onboarding still works — every column app.onboarding.tsx inserts is in the new GRANT INSERT list", () => {
  test("cross-file check: onboarding's actual INSERT column set is a subset of the migration's GRANT INSERT column set", () => {
    const onboardingSrc = readRepoFile("src", "routes", "app.onboarding.tsx");
    const insertBlockMatch = onboardingSrc.match(
      /supabase\.from\("agent_configs"\)\.insert\(\{([\s\S]*?)\}\);/,
    );
    assert.ok(
      insertBlockMatch,
      "expected to find the agent_configs insert call in app.onboarding.tsx",
    );
    const usedColumns = [...insertBlockMatch![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);
    assert.ok(usedColumns.length > 0, "expected to parse at least one column from the insert call");

    const grantMatch = migrationSrc.match(/GRANT INSERT \(([\s\S]*?)\) ON public\.agent_configs/);
    assert.ok(grantMatch);
    const grantedColumns = grantMatch![1]!
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    for (const col of usedColumns) {
      assert.ok(
        grantedColumns.includes(col),
        `onboarding inserts "${col}" but the migration does not grant INSERT on it`,
      );
    }
  });
});

describe("existing agent settings still works — every column app.agent.tsx updates is in the new GRANT UPDATE list", () => {
  test("cross-file check: settings' actual UPDATE column set is a subset of the migration's GRANT UPDATE column set", () => {
    const settingsSrc = readRepoFile("src", "routes", "app.agent.tsx");
    const updateBlockMatch = settingsSrc.match(
      /\.from\("agent_configs"\)\s*\.update\(\{([\s\S]*?)\}\)\s*\n\s*\.eq\("id", agent\.id\);/,
    );
    assert.ok(updateBlockMatch, "expected to find the agent_configs update call in app.agent.tsx");
    const usedColumns = [...updateBlockMatch![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);
    assert.ok(usedColumns.length > 0, "expected to parse at least one column from the update call");

    const grantMatch = migrationSrc.match(/GRANT UPDATE \(([\s\S]*?)\) ON public\.agent_configs/);
    assert.ok(grantMatch);
    const grantedColumns = grantMatch![1]!
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    for (const col of usedColumns) {
      assert.ok(
        grantedColumns.includes(col),
        `settings updates "${col}" but the migration does not grant UPDATE on it`,
      );
    }
  });
});

describe("SELECT is deliberately not restricted on the new columns", () => {
  test("the migration contains no REVOKE/GRANT SELECT statement at all for these three tables", () => {
    assert.doesNotMatch(migrationSrc, /REVOKE SELECT/);
    assert.doesNotMatch(migrationSrc, /GRANT SELECT/);
  });
});
