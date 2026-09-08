import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for sarvam-admin.functions.ts — the three admin
 * operations that record Sarvam provider-mapping identifiers against
 * Klyro's own records (app mapping, connection registration, inbound
 * deployment creation). createServerFn-wrapped handlers, same testing
 * approach as telephony-admin.functions.test.ts: a source scan, since this
 * repo's Node-native test runner cannot safely import/execute
 * createServerFn modules or reach a live Supabase instance.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "sarvam-admin.functions.ts"),
  "utf8",
);

function extractFn(name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `expected to find export const ${name}`);
  const nextExportIdx = src.indexOf("\nexport const ", start + 1);
  return nextExportIdx > -1 ? src.slice(start, nextExportIdx) : src.slice(start);
}

describe("unauthorized admin access rejected — every function gates before any DB write", () => {
  for (const [name, capability] of [
    ["setSarvamAppMapping", "agents.write"],
    ["registerTelephonyConnection", "numbers.write"],
    ["createSarvamInboundDeployment", "numbers.write"],
  ] as const) {
    test(`${name} calls assertPlatformAdmin("${capability}") before the first Supabase call`, () => {
      const fnSrc = extractFn(name);
      const adminCallText = `assertPlatformAdmin(context.supabase, context.userId, "${capability}")`;
      const adminIdx = fnSrc.indexOf(adminCallText);
      assert.ok(adminIdx > -1, `${name} must gate on ${capability}`);
      const beforeGate = fnSrc.slice(0, adminIdx);
      assert.equal(
        beforeGate.includes(".from("),
        false,
        `${name} must not touch the database before the admin gate`,
      );
    });
  }
});

describe("admin can modify mapping — all writes go through service_role (supabaseAdmin), never the caller's own client", () => {
  for (const name of [
    "setSarvamAppMapping",
    "registerTelephonyConnection",
    "createSarvamInboundDeployment",
  ]) {
    test(`${name} imports and uses supabaseAdmin for its writes`, () => {
      const fnSrc = extractFn(name);
      assert.match(
        fnSrc,
        /const \{ supabaseAdmin \} = await import\("@\/integrations\/supabase\/client\.server"\)/,
      );
      assert.match(fnSrc, /supabaseAdmin\s*\n?\s*\.from\(/);
    });
  }
});

describe("setSarvamAppMapping — duplicate app ID rejected, audited, validated", () => {
  const fnSrc = extractFn("setSarvamAppMapping");

  test("validates sarvamAppVersion is a positive integer and sarvamAppId is non-empty before any DB call", () => {
    assert.match(
      fnSrc,
      /!Number\.isInteger\(input\.sarvamAppVersion\) \|\| input\.sarvamAppVersion < 1/,
    );
    assert.match(fnSrc, /input\.sarvamAppId\?\.trim\(\)/);
  });

  test("translates the unique-index violation (23505) into a clear, non-leaking error", () => {
    assert.match(fnSrc, /code.*===\s*"23505"/);
    assert.match(fnSrc, /already mapped to a different agent/i);
  });

  test("writes an audit record with the resolved organization_id, old and new values", () => {
    assert.match(fnSrc, /action:\s*"SARVAM_APP_MAPPING_SET"/);
    assert.match(fnSrc, /organizationId:\s*before\.organization_id/);
    assert.match(fnSrc, /oldValue:\s*\{\s*sarvam_app_id:\s*before\.sarvam_app_id/);
  });
});

describe("registerTelephonyConnection — duplicate connection rejected, upserts per (org, provider)", () => {
  const fnSrc = extractFn("registerTelephonyConnection");

  test("looks up an existing row by (organization_id, provider='sarvam') before deciding insert vs update", () => {
    assert.match(fnSrc, /\.eq\("organization_id", data\.orgId\)/);
    assert.match(fnSrc, /\.eq\("provider", "sarvam"\)/);
  });

  test("translates the unique-index violation (23505) into a clear, non-leaking error on both the insert and update paths", () => {
    const occurrences = [...fnSrc.matchAll(/code.*===\s*"23505"/g)];
    assert.equal(
      occurrences.length,
      2,
      "expected the 23505 check on both the update-existing and insert-new branches",
    );
    assert.match(fnSrc, /already registered to a different organization/i);
  });

  test("writes an audit record", () => {
    assert.match(fnSrc, /action:\s*"SARVAM_CONNECTION_REGISTERED"/);
  });
});

describe("createSarvamInboundDeployment — cross-tenant mapping structurally rejected", () => {
  const fnSrc = extractFn("createSarvamInboundDeployment");

  test("rejects a request whose phone numbers span more than one organization", () => {
    assert.match(fnSrc, /const orgIds = new Set\(numbers\.map\(\(n\) => n\.organization_id\)\)/);
    assert.match(fnSrc, /orgIds\.size > 1/);
    assert.match(fnSrc, /must belong to the same organization/i);
  });

  test("rejects a request whose phone numbers span more than one connection or agent (a deployment is one connection + one app)", () => {
    assert.match(fnSrc, /connectionIds\.size > 1/);
    assert.match(fnSrc, /agentConfigIds\.size > 1/);
  });

  test("validates the connection is Sarvam-registered and the agent is Sarvam-mapped before ever calling the adapter", () => {
    const adapterCallIdx = fnSrc.indexOf("getTelephonyAdapter(");
    const connectionCheckIdx = fnSrc.indexOf("if (!connection.provider_connection_id)");
    const agentCheckIdx = fnSrc.indexOf(
      "if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)",
    );
    assert.ok(connectionCheckIdx > -1 && agentCheckIdx > -1 && adapterCallIdx > -1);
    assert.ok(
      connectionCheckIdx < adapterCallIdx,
      "connection validation must precede the Sarvam call",
    );
    assert.ok(agentCheckIdx < adapterCallIdx, "agent validation must precede the Sarvam call");
  });

  test("does not fake success: provider_deployment_id is only written and audited AFTER the adapter call, never before or unconditionally", () => {
    const adapterCallIdx = fnSrc.indexOf("await sarvamAdapter.createInboundDeployment(");
    const dbWriteIdx = fnSrc.indexOf(".update({ provider_deployment_id: created.deploymentId })");
    const auditIdx = fnSrc.indexOf('action: "SARVAM_DEPLOYMENT_CREATED"');
    assert.ok(adapterCallIdx > -1 && dbWriteIdx > -1 && auditIdx > -1);
    assert.ok(
      adapterCallIdx < dbWriteIdx,
      "the Sarvam call must happen before provider_deployment_id is stored",
    );
    assert.ok(dbWriteIdx < auditIdx, "the DB write must happen before the audit record");
  });

  test("accepts multiple phone number IDs in a single call — the API shape supports one deployment spanning many numbers", () => {
    assert.match(fnSrc, /input\?\.phoneNumberIds\?\.length/);
    assert.match(fnSrc, /\.in\("id", data\.phoneNumberIds\)/);
    assert.match(fnSrc, /phoneNumbers:\s*numbers\.map\(\(n\) => n\.e164\)/);
  });
});
