import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Phase 3 regression coverage: publishAgentVersion/rollbackAgentVersion's
 * Sarvam synchronization must never mark success when the provider call
 * failed, and must never touch the Klyro-side active version before that
 * sync resolves. Source-scanned like every other createServerFn handler in
 * this codebase (see sarvam-admin.functions.test.ts) — this repo's
 * Node-native test runner cannot safely import/execute createServerFn
 * modules or reach a live Supabase instance. HTTP-mocked behavioral
 * coverage of the Sarvam call itself lives in sarvam-api-client.server.test.ts;
 * this file asserts the ordering/presence of the safety guarantees around it.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "agent.functions.ts"),
  "utf8",
);

function extractFn(name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `expected to find export const ${name}`);
  const nextExportIdx = src.indexOf("\nexport const ", start + 1);
  return nextExportIdx > -1 ? src.slice(start, nextExportIdx) : src.slice(start);
}

describe("publishAgentVersion — Sarvam sync never marks fake success", () => {
  const fnSrc = extractFn("publishAgentVersion");

  test("calls syncPublishedAgentToSarvam before the agent_versions insert", () => {
    const syncIdx = fnSrc.indexOf("syncPublishedAgentToSarvam(");
    const insertIdx = fnSrc.indexOf('supabaseAdmin.from("agent_versions").insert(');
    assert.ok(syncIdx > -1 && insertIdx > -1);
    assert.ok(syncIdx < insertIdx, "Sarvam sync must run before the Klyro version is written");
  });

  test("a thrown sync error returns ok:false and never reaches the agent_versions insert", () => {
    const catchIdx = fnSrc.indexOf("} catch (err) {");
    const returnFalseIdx = fnSrc.indexOf(
      'return { ok: false as const, issues: [{ field: "Sarvam sync"',
    );
    const insertIdx = fnSrc.indexOf('supabaseAdmin.from("agent_versions").insert(');
    assert.ok(catchIdx > -1 && returnFalseIdx > -1 && insertIdx > -1);
    assert.ok(catchIdx < returnFalseIdx && returnFalseIdx < insertIdx);
  });

  test("active_version is only updated after the agent_versions insert succeeds", () => {
    const insertIdx = fnSrc.indexOf('supabaseAdmin.from("agent_versions").insert(');
    const activeVersionIdx = fnSrc.indexOf("active_version: version");
    assert.ok(insertIdx > -1 && activeVersionIdx > -1);
    assert.ok(insertIdx < activeVersionIdx);
  });

  test("emits agent_publish_started, and agent_publish_failed OR agent_publish_succeeded depending on outcome", () => {
    assert.match(fnSrc, /action:\s*"agent_publish_started"/);
    assert.match(fnSrc, /action:\s*"agent_publish_failed"/);
    assert.match(fnSrc, /action:\s*"agent_publish_succeeded"/);
  });

  test("agent_publish_failed is recorded for both a Sarvam sync failure and a database insert failure", () => {
    const occurrences = [...fnSrc.matchAll(/action:\s*"agent_publish_failed"/g)];
    assert.equal(occurrences.length, 2);
  });

  test("the audit entity_id is resolved server-side from agent_configs by business_id, never from client input", () => {
    assert.match(
      fnSrc,
      /\.from\("agent_configs"\)\s*\n\s*\.select\("id"\)\s*\n\s*\.eq\("business_id", data\.businessId\)/,
    );
    assert.doesNotMatch(fnSrc, /entityId:\s*data\./);
  });

  test("does not accept a client-supplied organizationId or entityId in its input schema", () => {
    assert.doesNotMatch(fnSrc, /organizationId:\s*z\./);
    assert.doesNotMatch(fnSrc, /entityId:\s*z\./);
  });
});

describe("saveAgentConfiguration — save-only workflow activates the existing agent, never duplicates it", () => {
  const fnSrc = extractFn("saveAgentConfiguration");

  test("resolves organizationId via requireBusinessAccess — tenant isolation, never trusts a client-supplied org", () => {
    assert.match(
      fnSrc,
      /const \{ organizationId \} = await requireBusinessAccess\(context\.supabase, data\.businessId\)/,
    );
  });

  test("does not accept a client-supplied organizationId in its input schema", () => {
    const inputSchemaStart = src.indexOf("const saveAgentConfigurationInput = z.object({");
    const inputSchemaEnd = src.indexOf("\n});", inputSchemaStart);
    const inputSchema = src.slice(inputSchemaStart, inputSchemaEnd);
    assert.doesNotMatch(inputSchema, /organizationId:\s*z\./);
  });

  test("looks up the existing agent_configs row by business_id and throws rather than creating a new one when missing", () => {
    assert.match(
      fnSrc,
      /\.from\("agent_configs"\)\s*\n\s*\.select\("id, greetings, active_version"\)\s*\n\s*\.eq\("business_id", data\.businessId\)/,
    );
    assert.match(
      fnSrc,
      /if \(!agentRow\) throw new Error\("Agent configuration not found for this business\."\);/,
    );
  });

  test("only ever updates agent_configs — never inserts a second row for the same business", () => {
    assert.doesNotMatch(fnSrc, /\.from\("agent_configs"\)\s*\n\s*\.insert\(/);
    const updateOccurrences = [...fnSrc.matchAll(/\.from\("agent_configs"\)\s*\n\s*\.update\(/g)];
    assert.equal(
      updateOccurrences.length,
      2,
      "one update for fields, one for status/active_version",
    );
  });

  test("merges the new greeting into existing greetings by language rather than discarding other languages", () => {
    assert.match(
      fnSrc,
      /const greetings = \{\s*\n\s*\.\.\.\(\(agentRow\.greetings as Record<string, string> \| null\) \?\? \{\}\),\s*\n\s*\[data\.primary_language\]: data\.greeting,\s*\n\s*\};/,
    );
  });

  test("re-validates via the same validateAgentConfig used by publish, from a fresh loadSnapshot after the write", () => {
    const updateIdx = fnSrc.indexOf(".update({\n        agent_name:");
    const snapshotIdx = fnSrc.indexOf(
      "const snapshot = await loadSnapshot(context.supabase, data.businessId);",
    );
    const validateIdx = fnSrc.indexOf("const issues = validateAgentConfig(snapshot);");
    assert.ok(updateIdx > -1 && snapshotIdx > -1 && validateIdx > -1);
    assert.ok(updateIdx < snapshotIdx && snapshotIdx < validateIdx);
  });

  test("uses non-throwing checkFeatureAccess and folds a locked voice feature into the returned issues, never throws for an unpaid customer", () => {
    assert.match(fnSrc, /const voiceGate = await checkFeatureAccess\(organizationId, "voice"\);/);
    assert.match(fnSrc, /if \(!voiceGate\.allowed\) \{/);
    assert.match(fnSrc, /field: "Billing"/);
    assert.doesNotMatch(fnSrc, /assertFeatureUnlocked/);
  });

  test("status becomes ready only when there are zero issues; otherwise stays not_configured", () => {
    assert.match(fnSrc, /const ready = issues\.length === 0;/);
    assert.match(fnSrc, /status: ready \? "ready" : "not_configured"/);
  });

  test("active_version only ever advances (never regresses) and only when ready", () => {
    assert.match(
      fnSrc,
      /active_version: ready \? Math\.max\(agentRow\.active_version, 1\) : agentRow\.active_version/,
    );
  });

  test("records agent_saved_ready or agent_saved_incomplete depending on outcome", () => {
    assert.match(fnSrc, /action: ready \? "agent_saved_ready" : "agent_saved_incomplete"/);
  });

  test("the status/active_version update happens after the field update and the validity check, never before", () => {
    const fieldUpdateIdx = fnSrc.indexOf(".update({\n        agent_name:");
    const issuesIdx = fnSrc.indexOf("const issues = validateAgentConfig(snapshot);");
    const statusUpdateIdx = fnSrc.indexOf('status: ready ? "ready" : "not_configured"');
    assert.ok(fieldUpdateIdx > -1 && issuesIdx > -1 && statusUpdateIdx > -1);
    assert.ok(fieldUpdateIdx < issuesIdx && issuesIdx < statusUpdateIdx);
  });

  test("never touches agent_versions — the versioning/publish table is left entirely alone by this function", () => {
    assert.doesNotMatch(fnSrc, /agent_versions/);
  });
});

describe("rollbackAgentVersion — same fail-closed guarantees as publish", () => {
  const fnSrc = extractFn("rollbackAgentVersion");

  test("calls syncPublishedAgentToSarvam before archiving/reactivating any agent_versions row", () => {
    const syncIdx = fnSrc.indexOf("syncPublishedAgentToSarvam(");
    const archiveIdx = fnSrc.indexOf('.update({ status: "archived" })');
    assert.ok(syncIdx > -1 && archiveIdx > -1);
    assert.ok(syncIdx < archiveIdx);
  });

  test("a thrown sync error is re-thrown before any agent_versions/agent_configs write", () => {
    const catchIdx = fnSrc.indexOf("} catch (err) {");
    const throwIdx = fnSrc.indexOf("throw new Error(message);");
    const archiveIdx = fnSrc.indexOf('.update({ status: "archived" })');
    assert.ok(catchIdx > -1 && throwIdx > -1 && archiveIdx > -1);
    assert.ok(catchIdx < throwIdx && throwIdx < archiveIdx);
  });

  test("emits agent_rollback_started/succeeded/failed", () => {
    assert.match(fnSrc, /action:\s*"agent_rollback_started"/);
    assert.match(fnSrc, /action:\s*"agent_rollback_failed"/);
    assert.match(fnSrc, /action:\s*"agent_rollback_succeeded"/);
  });

  test("rejects a version that does not exist before any sync attempt or write", () => {
    const notFoundIdx = fnSrc.indexOf(
      'if (!target) throw new Error("That version no longer exists.");',
    );
    const syncIdx = fnSrc.indexOf("syncPublishedAgentToSarvam(");
    assert.ok(notFoundIdx > -1 && syncIdx > -1);
    assert.ok(notFoundIdx < syncIdx);
  });
});

describe("recordAgentEvent — safe audit logging, never blocks the caller, never logs secrets", () => {
  test("wraps the insert in try/catch so a logging failure cannot break publish/rollback", () => {
    const fnStart = src.indexOf("async function recordAgentEvent(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(fnBody, /try \{/);
    assert.match(fnBody, /catch \(error\)/);
  });

  test("reuses the existing audit_logs table — no new logging table/mechanism introduced", () => {
    assert.match(src, /\.from\("audit_logs"\)\.insert\(/);
  });

  test("no API key, token, or secret material appears anywhere in this file", () => {
    for (const forbidden of ["SARVAM_API_KEY", "apiKey", "api_key", "Authorization", "Bearer "]) {
      assert.equal(src.includes(forbidden), false, `must not reference ${forbidden}`);
    }
  });
});

describe("agent-sarvam-sync.server.ts is imported, not a second Sarvam fetch wrapper reinvented inline", () => {
  test("agent.functions.ts imports syncPublishedAgentToSarvam rather than calling fetch/adapter methods directly", () => {
    assert.match(
      src,
      /import \{ syncPublishedAgentToSarvam \} from "\.\/agent-sarvam-sync\.server"/,
    );
    assert.doesNotMatch(src, /getTelephonyAdapter/);
    assert.doesNotMatch(src, /new SarvamTelephonyAdapter/);
  });
});
