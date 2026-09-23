import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Coverage for the WhatsApp Business integration migration (Phase 1). No
 * live Postgres instance is available in this environment (see
 * phone-number-pool.test.ts's doc comment for why every migration test here
 * is a source scan, not an execution test) — these assertions verify the
 * SQL text contains the specific isolation/security invariants this
 * migration is required to establish, not that Postgres accepts the file.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(migrationsDir, "20260923090000_whatsapp_business_integration.sql");

function readSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

test("all three tables enable row level security", () => {
  const sql = readSql();
  for (const table of ["whatsapp_connections", "whatsapp_conversations", "whatsapp_messages"]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`),
      `expected RLS enabled on ${table}`,
    );
  }
});

test("all three tables scope customer SELECT through is_org_member(organization_id)", () => {
  const sql = readSql();
  for (const table of ["whatsapp_connections", "whatsapp_conversations", "whatsapp_messages"]) {
    const tableBlock = sql.slice(sql.indexOf(`CREATE TABLE public.${table} (`));
    assert.match(
      tableBlock.slice(0, tableBlock.indexOf("FOR SELECT TO authenticated") + 200),
      /public\.is_org_member\(organization_id\)/,
      `expected ${table}'s SELECT policy to gate on is_org_member(organization_id)`,
    );
  }
});

test("conversations and messages tables are never directly writable by authenticated (server-side only)", () => {
  const sql = readSql();
  assert.doesNotMatch(
    sql,
    /GRANT (INSERT|UPDATE|DELETE|ALL) ON public\.whatsapp_conversations TO authenticated/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (INSERT|UPDATE|DELETE|ALL) ON public\.whatsapp_messages TO authenticated/,
  );
});

test("whatsapp_connections restricts the customer UPDATE grant to agent_config_id only", () => {
  const sql = readSql();
  assert.match(
    sql,
    /GRANT SELECT, UPDATE \(agent_config_id\) ON public\.whatsapp_connections TO authenticated;/,
  );
  assert.doesNotMatch(sql, /GRANT ALL ON public\.whatsapp_connections TO authenticated/);
});

test("access_token_ciphertext and two_step_pin_ciphertext are excluded from the authenticated SELECT grant", () => {
  const sql = readSql();
  assert.match(sql, /REVOKE SELECT ON public\.whatsapp_connections FROM authenticated;/);
  const grantMatch = sql.match(
    /GRANT SELECT \(([\s\S]*?)\) ON public\.whatsapp_connections TO authenticated;/,
  );
  assert.ok(grantMatch, "expected an explicit column-list SELECT grant on whatsapp_connections");
  const columns = grantMatch![1]!;
  assert.doesNotMatch(columns, /access_token_ciphertext/);
  assert.doesNotMatch(columns, /two_step_pin_ciphertext/);
  assert.match(columns, /\bstatus\b/);
  assert.match(columns, /\bagent_config_id\b/);
});

test("a Meta phone_number_id can never be live for two organizations at once", () => {
  const sql = readSql();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX idx_whatsapp_connections_phone_number_id_live\s*\n\s*ON public\.whatsapp_connections \(phone_number_id\) WHERE status <> 'disconnected';/,
  );
});

test("one conversation per (connection, wa_id) — prevents duplicate threads for the same customer", () => {
  const sql = readSql();
  assert.match(sql, /UNIQUE \(whatsapp_connection_id, wa_id\)/);
});

test("message idempotency is scoped per-connection on wa_message_id", () => {
  const sql = readSql();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX idx_whatsapp_messages_connection_wamid\s*\n\s*ON public\.whatsapp_messages \(whatsapp_connection_id, wa_message_id\) WHERE wa_message_id IS NOT NULL;/,
  );
});

test("bot assignment is a direct FK to agent_configs, matching the existing phone_numbers.agent_config_id convention", () => {
  const sql = readSql();
  assert.match(
    sql,
    /agent_config_id UUID REFERENCES public\.agent_configs\(id\) ON DELETE SET NULL,/,
  );
});

test("whatsapp_connections status is constrained to the documented lifecycle", () => {
  const sql = readSql();
  const constraintMatch = sql.match(
    /ADD CONSTRAINT whatsapp_connections_status_check\s*\n\s*CHECK \(status IN \(([\s\S]*?)\)\);/,
  );
  assert.ok(constraintMatch, "expected a whatsapp_connections_status_check CHECK constraint");
  const allowed = constraintMatch![1]!;
  for (const value of [
    "not_connected",
    "connecting",
    "connected",
    "error",
    "disconnected",
    "needs_attention",
  ]) {
    assert.match(allowed, new RegExp(`'${value}'`), `expected status '${value}' to be allowed`);
  }
});

test("all three tables cascade-delete with their owning organization", () => {
  const sql = readSql();
  for (const table of ["whatsapp_connections", "whatsapp_conversations", "whatsapp_messages"]) {
    const tableBlock = sql.slice(
      sql.indexOf(`CREATE TABLE public.${table} (`),
      sql.indexOf(`CREATE TABLE public.${table} (`) + 800,
    );
    assert.match(
      tableBlock,
      /organization_id UUID NOT NULL REFERENCES public\.organizations\(id\) ON DELETE CASCADE,/,
      `expected ${table}.organization_id to cascade-delete with organizations`,
    );
  }
});
