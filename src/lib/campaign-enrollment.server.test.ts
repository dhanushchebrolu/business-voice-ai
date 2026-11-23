import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildImportRows, importContactsAtomically } from "./campaign-enrollment.server.ts";
import { csvToTable, validateContactRows } from "./contacts-import.ts";
import { describeImportResult, describeUploadRow } from "./campaign-wizard.ts";

/**
 * MOCKED tests: the TypeScript side of the import (row building, the call to
 * the database function, reading its answer, the customer-facing text). The
 * transaction, the counts and the race are proven against real PostgreSQL in
 * supabase/migrations/campaign_contact_import_atomic.pg.test.ts and on the
 * local QA database; a fake rpc proves none of that.
 */

describe("rows sent to the database", () => {
  const summary = validateContactRows(
    csvToTable(
      "phone,Name,customer,city\n9000000001,Asha,,Pune\n9000000002,,Ravi K,\n9000000003,   ,,\n",
    ),
    "phone",
  );

  test("a blank or whitespace name is sent as null (never as an empty name)", () => {
    const rows = buildImportRows(summary.valid, {});
    assert.equal(rows[0]!.name, "Asha");
    assert.equal(rows[1]!.name, null);
    assert.equal(rows[2]!.name, null);
  });

  test("a column mapped to customer_name is the name, and mapped columns become variables", () => {
    const rows = buildImportRows(summary.valid, { customer: "customer_name", city: "city" });
    assert.equal(rows[1]!.name, "Ravi K");
    assert.deepEqual(rows[0]!.variables, { city: "Pune" });
    assert.equal(rows[0]!.name, "Asha", "falls back to the Name column");
  });

  test("phones are the server's normalized E.164 numbers", () => {
    assert.deepEqual(
      buildImportRows(summary.valid, {}).map((r) => r.phone),
      ["+919000000001", "+919000000002", "+919000000003"],
    );
  });
});

function fakeAdmin(answer: { data: unknown; error: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(answer);
    },
  };
  return { admin: admin as never, calls };
}

const RESULT = {
  upload_id: "up_1",
  replayed: false,
  total_rows: 6,
  valid_rows: 3,
  invalid_rows: 1,
  duplicate_rows: 2,
  enrolled: 1,
  already_in_campaign: 1,
  opted_out: 1,
};
const input = {
  organizationId: "org_a",
  campaignId: "camp_1",
  userId: "user_1",
  idempotencyKey: "cmp_0123456789abcdef0123456789abcdef",
  filename: "f.csv",
  summary: { totalRows: 6, invalid: [{ rowIndex: 1, phoneRaw: "x", reason: "r" }], duplicates: [] },
  rows: [],
};

describe("calling the transactional import (mocked database)", () => {
  test("one call to import_campaign_contacts with the authorized organization and the key", async () => {
    const { admin, calls } = fakeAdmin({ data: RESULT, error: null });
    await importContactsAtomically(admin, input);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.fn, "import_campaign_contacts");
    assert.equal(calls[0]!.args["_org"], "org_a");
    assert.equal(calls[0]!.args["_idempotency_key"], input.idempotencyKey);
    assert.equal(calls[0]!.args["_invalid_rows"], 1);
  });

  test("the database's counts are returned as they are", async () => {
    const { admin } = fakeAdmin({ data: RESULT, error: null });
    assert.deepEqual(await importContactsAtomically(admin, input), {
      uploadId: "up_1",
      replayed: false,
      totalRows: 6,
      valid: 3,
      invalid: 1,
      duplicatesInFile: 2,
      enrolled: 1,
      alreadyInCampaign: 1,
      optedOut: 1,
    });
  });

  test("a database error is raised, never turned into counts", async () => {
    const { admin } = fakeAdmin({ data: null, error: { message: "boom", code: "XX000" } });
    await assert.rejects(importContactsAtomically(admin, input), (e: { message?: string }) =>
      /boom/.test(e.message ?? ""),
    );
  });

  test("an incomplete answer fails the import instead of reporting guessed numbers", async () => {
    const { admin } = fakeAdmin({ data: { ...RESULT, enrolled: null }, error: null });
    await assert.rejects(importContactsAtomically(admin, input), /could not be read/);
  });
});

describe("what the customer is told", () => {
  test("a re-import says 0 added and how many were already there", () => {
    assert.equal(
      describeImportResult({
        replayed: false,
        totalRows: 3,
        valid: 3,
        invalid: 0,
        duplicatesInFile: 0,
        enrolled: 0,
        alreadyInCampaign: 3,
        optedOut: 0,
      }),
      "Import complete: 3 rows · 0 added · 3 already in campaign.",
    );
  });

  test("a replay says nothing was added again", () => {
    assert.match(
      describeImportResult({
        replayed: true,
        totalRows: 7,
        valid: 3,
        invalid: 3,
        duplicatesInFile: 1,
        enrolled: 3,
        alreadyInCampaign: 0,
        optedOut: 0,
      }),
      /^This import was already done; nothing was added again\. 7 rows · 3 added · 3 invalid · 1 duplicate row in file\.$/,
    );
  });

  test("history rows from before the new counts still read honestly (valid, not added)", () => {
    assert.equal(
      describeUploadRow({
        total_rows: 7,
        valid_rows: 3,
        invalid_rows: 3,
        duplicate_rows: 1,
        enrolled_rows: null,
        already_in_campaign_rows: null,
        opted_out_rows: null,
      }),
      "7 rows · 3 valid · 3 invalid · 1 duplicate row in file",
    );
  });
});

describe("source: the import goes through the transaction only", () => {
  const fns = readFileSync(new URL("./campaign-contacts.functions.ts", import.meta.url), "utf8");
  const handler = fns.slice(
    fns.indexOf("export const importCampaignContactsCsv"),
    fns.indexOf("interface EnrollExistingInput"),
  );
  test("no direct contact, membership or history writes remain in the CSV handler", () => {
    assert.doesNotMatch(
      handler,
      /from\("(contacts|campaign_contacts|campaign_uploads)"\)\s*\.(insert|update|upsert)/,
    );
    assert.match(handler, /importContactsAtomically\(supabaseAdmin,/);
  });
  test("the organization comes from server-side authorization, never from the request", () => {
    assert.match(handler, /const orgId = await campaignOrgId\(context, data\.campaignId\);/);
    assert.match(handler, /organizationId: orgId,/);
  });
  test("files over the row cap are refused before anything is written", () => {
    const cap = handler.indexOf("if (table.rows.length > MAX_IMPORT_ROWS)");
    assert.ok(cap > -1, "server-side cap");
    assert.ok(cap < handler.indexOf("importContactsAtomically("), "checked before the import");
  });
});

describe("the import row cap", () => {
  test("one shared cap of 5,000 rows, with a message that says what to do", async () => {
    const { MAX_IMPORT_ROWS, MAX_WIZARD_CONTACTS, IMPORT_TOO_LARGE_MESSAGE } =
      await import("./campaign-wizard.ts");
    assert.equal(MAX_IMPORT_ROWS, 5000);
    assert.equal(MAX_WIZARD_CONTACTS, MAX_IMPORT_ROWS);
    assert.match(IMPORT_TOO_LARGE_MESSAGE, /5,000 rows .* Split the file/);
  });
});
