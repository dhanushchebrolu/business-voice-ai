import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  WHATSAPP_SCHEMA_MISMATCH_MESSAGE,
  WhatsAppSchemaMismatchError,
  isSchemaMismatch,
  withSchemaContract,
} from "./whatsapp-schema-contract.server.ts";

/**
 * The production failure this guards: the Vobiz code ran against a database
 * without 20261027090000, and PostgreSQL's 42703 reached the browser raw.
 */

const PROD_ERROR = {
  code: "42703",
  message: "column whatsapp_connections.number_onboarding_mode does not exist",
};

function captureErrors<T>(fn: () => Promise<T>) {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  return fn()
    .finally(() => (console.error = original))
    .then(
      (value) => ({ value, logged, error: null as unknown }),
      (error: unknown) => ({ value: null, logged, error }),
    );
}

describe("WhatsApp schema contract", () => {
  test("missing column/table/function codes (PostgreSQL and PostgREST) are recognized; others aren't", () => {
    for (const code of ["42703", "42P01", "42883", "PGRST204", "PGRST205", "PGRST202"]) {
      assert.equal(isSchemaMismatch({ code, message: "x" }), true, code);
    }
    for (const err of [{ code: "23505" }, { code: "PGRST116" }, new Error("boom"), null, "42703"]) {
      assert.equal(isSchemaMismatch(err), false, JSON.stringify(err));
    }
  });

  test("the production 42703 becomes one clear error, and the log names the missing column only", async () => {
    const r = await captureErrors(() =>
      withSchemaContract("connectWhatsAppByon", async () => {
        throw PROD_ERROR;
      }),
    );
    assert.ok(r.error instanceof WhatsAppSchemaMismatchError);
    assert.equal((r.error as Error).message, WHATSAPP_SCHEMA_MISMATCH_MESSAGE);
    assert.doesNotMatch((r.error as Error).message, /number_onboarding_mode|42703/);
    assert.deepEqual(r.logged, [
      ["whatsapp:schema_mismatch", { where: "connectWhatsAppByon", ...PROD_ERROR }],
    ]);
  });

  test("other errors pass through unchanged and unlogged; success passes through", async () => {
    const dup = { code: "23505", message: "duplicate" };
    const r = await captureErrors(() =>
      withSchemaContract("x", async () => {
        throw dup;
      }),
    );
    assert.equal(r.error, dup);
    assert.equal(r.logged.length, 0);
    assert.equal(await withSchemaContract("x", async () => 7), 7);
  });
});
