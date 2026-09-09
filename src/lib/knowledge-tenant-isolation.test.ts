import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Phase 4 (Customer Knowledge Base) — cross-file security regression suite.
 *
 * The user's requirement across every phase of this project: the tenant
 * knowledge base (knowledge_documents) must remain completely separate from
 * the global public_knowledge_base used by the unauthenticated public
 * website AI, and every tenant-scoped read/write must be provably scoped to
 * the caller's own organization. No new table or migration was introduced
 * for Phase 4 — this suite proves that decision holds by grepping the base
 * migration's actual RLS policy and every file that touches
 * knowledge_documents, rather than asserting it from prose.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

describe("knowledge_documents RLS — the sole tenant-isolation enforcement point", () => {
  test("the base migration enables RLS and gates every operation through is_org_member(organization_id)", () => {
    const migration = src(
      "supabase",
      "migrations",
      "20260829120932_c8cdfc97-92e1-4fd0-b400-793aaddbbbc1.sql",
    );
    const idx = migration.indexOf("CREATE TABLE public.knowledge_documents");
    assert.ok(idx > -1);
    const block = migration.slice(idx, idx + 1500);
    assert.match(block, /ALTER TABLE public\.knowledge_documents ENABLE ROW LEVEL SECURITY/);
    assert.match(
      block,
      /CREATE POLICY "tenant knowledge" ON public\.knowledge_documents FOR ALL TO authenticated USING \(public\.is_org_member\(organization_id\)\) WITH CHECK \(public\.is_org_member\(organization_id\)\)/,
    );
    // No anon grant exists — an unauthenticated caller has no access path at all.
    assert.doesNotMatch(block, /GRANT[^;]*\banon\b[^;]*knowledge_documents/i);
  });

  test("no second migration re-defines or relaxes knowledge_documents RLS/grants (Phase 4 added zero migrations)", () => {
    const dir = join(root, "supabase", "migrations");
    const files: string[] = readdirSync(dir);
    const touching = files.filter((f) => {
      if (!f.endsWith(".sql")) return false;
      const text = readFileSync(join(dir, f), "utf8");
      return text.includes("knowledge_documents");
    });
    assert.deepEqual(
      touching,
      ["20260829120932_c8cdfc97-92e1-4fd0-b400-793aaddbbbc1.sql"],
      "knowledge_documents must only be defined in the original base migration",
    );
  });
});

describe("public/tenant knowledge separation — two distinct tables, never mixed", () => {
  test("public_knowledge_base has no organization_id/business_id column and is never joined to knowledge_documents", () => {
    const migration = src("supabase", "migrations", "20260905080100_public_knowledge_base.sql");
    const idx = migration.indexOf("CREATE TABLE");
    const block = migration.slice(idx, idx + 1200);
    assert.doesNotMatch(block, /organization_id|business_id/);
    assert.doesNotMatch(migration, /knowledge_documents/);
  });

  test("public-assistant.functions.ts (the unauthenticated public AI) never queries knowledge_documents — the only mention is its own isolation doc-comment", () => {
    const paSrc = src("src", "lib", "public-assistant.functions.ts");
    assert.doesNotMatch(paSrc, /\.from\("knowledge_documents"\)/);
    // The one textual mention must be inside the module doc comment that
    // explicitly forbids touching it, not executable code.
    const mentions = [...paSrc.matchAll(/knowledge_documents/g)];
    assert.equal(mentions.length, 1, "expected exactly one mention (the doc-comment warning)");
    const commentBlockEnd = paSrc.indexOf("*/");
    const mentionIndex = mentions[0]?.index;
    assert.ok(
      mentionIndex !== undefined && mentionIndex < commentBlockEnd,
      "the mention must be inside the leading doc comment",
    );
  });

  test("public-assistant.functions.ts only ever reads from public_knowledge_base, filtered to is_active", () => {
    const paSrc = src("src", "lib", "public-assistant.functions.ts");
    const idx = paSrc.indexOf('.from("public_knowledge_base")');
    assert.ok(idx > -1, "expected the public assistant to read public_knowledge_base");
    assert.match(paSrc.slice(idx, idx + 200), /is_active/);
  });
});

describe("admin access — Customer 360's Knowledge tab reuses the existing platform-admin gate, not a new one", () => {
  test("the knowledge query added to getCustomerDetail sits inside the function already gated by assertPlatformAdmin", () => {
    const adminSrc = src("src", "lib", "admin.functions.ts");
    const fnStart = adminSrc.indexOf("export const getCustomerDetail = createServerFn");
    const nextExportIdx = adminSrc.indexOf("\nexport const ", fnStart + 1);
    const fnSrc =
      nextExportIdx > -1 ? adminSrc.slice(fnStart, nextExportIdx) : adminSrc.slice(fnStart);

    const adminGateIdx = fnSrc.indexOf(
      'assertPlatformAdmin(context.supabase, context.userId, "customers.read")',
    );
    const knowledgeIdx = fnSrc.indexOf('.from("knowledge_documents")');
    assert.ok(adminGateIdx > -1 && knowledgeIdx > -1);
    assert.ok(adminGateIdx < knowledgeIdx, "the admin gate must run before the knowledge query");
    assert.match(fnSrc.slice(knowledgeIdx, knowledgeIdx + 250), /\.eq\("organization_id", orgId\)/);
  });

  test("the Customer 360 route renders the knowledge summary from data.knowledge (server-resolved), never a client-supplied orgId re-fetch", () => {
    const routeSrc = src("src", "routes", "admin.customers.$orgId.tsx");
    assert.match(routeSrc, /data\.knowledge/);
    assert.doesNotMatch(
      routeSrc,
      /\.from\("knowledge_documents"\)/,
      "the route itself must not query Supabase directly",
    );
  });
});

describe("customer nav wiring — /app/knowledge is reachable, protected by the same auth boundary as the rest of /app", () => {
  test("Shell.tsx links to /app/knowledge alongside the other Configure-group routes", () => {
    const shellSrc = src("src", "components", "app", "Shell.tsx");
    assert.match(shellSrc, /\{\s*to:\s*"\/app\/knowledge",\s*label:\s*"Knowledge base"/);
  });

  test("app.knowledge.tsx does not opt out of the app layout's auth requirement (no public/anon route markers)", () => {
    const routeSrc = src("src", "routes", "app.knowledge.tsx");
    assert.doesNotMatch(routeSrc, /requireSupabaseAuth\s*:\s*false|public\s*:\s*true|anonymous/i);
  });
});
