import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for Phase G: converting a WON demo request into a
 * provisioned customer through the existing createClientAccount path (no
 * parallel provisioning function). Source-scanned, matching this repo's
 * convention for createServerFn modules.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const adminClientsSrc = readFileSync(join(dir, "admin-clients.functions.ts"), "utf8");
const dialogSrc = readFileSync(
  join(dir, "..", "components", "admin", "CreateClientDialog.tsx"),
  "utf8",
);
const customersIndexSrc = readFileSync(
  join(dir, "..", "routes", "admin.customers.index.tsx"),
  "utf8",
);

function extractFn(name: string): string {
  const start = adminClientsSrc.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `expected to find export const ${name}`);
  const nextExportIdx = adminClientsSrc.indexOf("\nexport const ", start + 1);
  return nextExportIdx > -1
    ? adminClientsSrc.slice(start, nextExportIdx)
    : adminClientsSrc.slice(start);
}

describe("createClientAccount converting a demo request is idempotent against repeated clicks", () => {
  const fnSrc = extractFn("createClientAccount");

  test("an already-converted demo request is rejected before the organization insert", () => {
    const guardIdx = fnSrc.indexOf("if (demoRequest.converted)");
    const insertIdx = fnSrc.indexOf('.from("organizations")\n      .insert(');
    assert.ok(guardIdx > -1 && insertIdx > -1);
    assert.ok(
      guardIdx < insertIdx,
      "the converted check must run before any organization is created",
    );
  });

  test("a missing demo request id is rejected rather than silently proceeding", () => {
    assert.match(fnSrc, /if \(!demoRequest\) throw new Error\("Demo request not found"\);/);
  });

  test("the contact-email dedupe check still runs for every creation, converted or not", () => {
    const dedupeIdx = fnSrc.indexOf('.ilike("contact_email", email)');
    assert.ok(dedupeIdx > -1);
  });
});

describe("a successful conversion links the demo request back to the new organization", () => {
  const fnSrc = extractFn("createClientAccount");

  test("demo_requests is updated with status=WON, converted=true and the new organization_id, after the org+audit already succeeded", () => {
    const auditIdx = fnSrc.indexOf('action: "CREATE_CLIENT"');
    const linkIdx = fnSrc.indexOf('.from("demo_requests")\n        .update(');
    assert.ok(auditIdx > -1 && linkIdx > -1);
    assert.ok(
      auditIdx < linkIdx,
      "the organization must be fully created+audited before linking the demo request",
    );
    const block = fnSrc.slice(linkIdx, linkIdx + 200);
    assert.match(block, /status: "WON"/);
    assert.match(block, /converted: true/);
    assert.match(block, /organization_id: org\.id/);
  });

  test("the conversion link is audited as its own action, separate from CREATE_CLIENT", () => {
    assert.match(fnSrc, /action: "demo_request\.converted"/);
  });

  test("a failure linking the demo request back does not roll back or fail the already-created organization", () => {
    const linkIdx = fnSrc.indexOf('.from("demo_requests")\n        .update(');
    const block = fnSrc.slice(linkIdx, linkIdx + 500);
    assert.doesNotMatch(block, /throw convertError/);
    assert.match(block, /console\.error\(/);
  });
});

describe("CreateClientDialog is the single shared form for both entry points", () => {
  test("it accepts controlled open state, prefill values and a sourceDemoRequestId — no second create-customer form exists", () => {
    assert.match(dialogSrc, /open\?:\s*boolean/);
    assert.match(dialogSrc, /onOpenChange\?:/);
    assert.match(dialogSrc, /initial\?:\s*Partial<typeof empty>/);
    assert.match(dialogSrc, /sourceDemoRequestId\?:\s*string/);
  });

  test("sourceDemoRequestId is forwarded to createClientAccount's input, not handled by a separate function", () => {
    const submitIdx = dialogSrc.indexOf("const submit = async () => {");
    const block = dialogSrc.slice(submitIdx, submitIdx + 1200);
    assert.match(block, /sourceDemoRequestId,/);
  });

  test("the trigger button is hidden when opened programmatically (showTrigger=false), so no duplicate 'Create client' button appears", () => {
    assert.match(dialogSrc, /showTrigger \? \(/);
  });
});

describe("the demo-request conversion link reaches CreateClientDialog through the customers route's own search params", () => {
  test("admin.customers.index.tsx's validateSearch accepts demoRequestId + prefill fields, all optional so other Link/navigate call sites are unaffected", () => {
    assert.match(customersIndexSrc, /demoRequestId\?:\s*string \| undefined/);
    assert.match(customersIndexSrc, /prefillName\?:\s*string \| undefined/);
  });

  test("presence of demoRequestId auto-opens a controlled CreateClientDialog with the prefilled values", () => {
    assert.match(customersIndexSrc, /useState\(Boolean\(demoRequestId\)\)/);
    assert.match(customersIndexSrc, /sourceDemoRequestId=\{demoRequestId\}/);
  });
});
