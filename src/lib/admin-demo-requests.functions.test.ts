import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the demo-requests admin CRM server functions.
 * Source-scanned, matching this repo's established convention for
 * createServerFn modules this test runner can't safely import/execute
 * (see admin.functions.test.ts).
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "admin-demo-requests.functions.ts"),
  "utf8",
);

function extractFn(name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `expected to find export const ${name}`);
  const nextExportIdx = src.indexOf("\nexport const ", start + 1);
  return nextExportIdx > -1 ? src.slice(start, nextExportIdx) : src.slice(start);
}

describe("every handler requires authentication and platform-admin authorization before touching data", () => {
  for (const name of ["listDemoRequests", "updateDemoRequestStatus", "updateDemoRequestNotes"]) {
    test(`${name} is wrapped in requireSupabaseAuth and gates via assertPlatformAdmin before any .from(`, () => {
      const fnSrc = extractFn(name);
      assert.match(fnSrc, /\.middleware\(\[requireSupabaseAuth\]\)/);
      const gateIdx = fnSrc.indexOf("assertPlatformAdmin(context.supabase, context.userId");
      assert.ok(gateIdx > -1, `${name} must call assertPlatformAdmin`);
      const handlerIdx = fnSrc.indexOf(".handler(async");
      const beforeGate = fnSrc.slice(handlerIdx, gateIdx);
      assert.equal(
        beforeGate.includes(".from("),
        false,
        `${name} must not touch the DB before the admin gate`,
      );
    });
  }

  test("listDemoRequests only requires customers.read (available to every admin role)", () => {
    assert.match(extractFn("listDemoRequests"), /"customers\.read"/);
  });

  test("mutations (status/notes) require customers.write", () => {
    assert.match(extractFn("updateDemoRequestStatus"), /"customers\.write"/);
    assert.match(extractFn("updateDemoRequestNotes"), /"customers\.write"/);
  });
});

describe("status updates are validated against the canonical vocabulary and audited", () => {
  test("DEMO_REQUEST_STATUSES is the single source of truth for valid status values", () => {
    assert.match(
      src,
      /export const DEMO_REQUEST_STATUSES = \[\s*"NEW",\s*"CONTACTED",\s*"DEMO_SCHEDULED",\s*"WON",\s*"LOST",?\s*\]/,
    );
  });

  test("updateDemoRequestStatus's inputValidator rejects any status outside DEMO_REQUEST_STATUSES", () => {
    const fnSrc = extractFn("updateDemoRequestStatus");
    assert.match(fnSrc, /DEMO_REQUEST_STATUSES\.includes\(input\.status\)/);
  });

  test("both mutations write an audit record via writeAudit", () => {
    assert.match(extractFn("updateDemoRequestStatus"), /await writeAudit\(/);
    assert.match(extractFn("updateDemoRequestNotes"), /await writeAudit\(/);
  });

  test("both mutations 404 on an unknown id rather than silently upserting one", () => {
    for (const name of ["updateDemoRequestStatus", "updateDemoRequestNotes"]) {
      const fnSrc = extractFn(name);
      assert.match(fnSrc, /if \(!previous\) throw new Error\("Demo request not found"\);/);
    }
  });
});

describe("listDemoRequests never exposes another table's admin-only data beyond a safe organization summary", () => {
  test("the organization join is limited to id/name/client_id/lifecycle_status — no financial or contact fields", () => {
    const fnSrc = extractFn("listDemoRequests");
    const selectIdx = fnSrc.indexOf('.from("organizations")');
    assert.ok(selectIdx > -1);
    const block = fnSrc.slice(selectIdx, selectIdx + 150);
    assert.match(block, /select\("id, name, client_id, lifecycle_status"\)/);
  });
});

describe("this module never touches the public submission path", () => {
  test("no reference to the public contact route, and no INSERT statement anywhere in this admin-only module", () => {
    assert.doesNotMatch(src, /routes\/contact/);
    assert.doesNotMatch(src, /\.insert\(/);
  });
});
