import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Phase 4 (Customer Knowledge Base) coverage for the customer-facing
 * /app/knowledge route. Source-scanned like every other route/handler in
 * this codebase (see service-lock-message.test.ts) — no DOM-rendering setup
 * exists here, and this route makes real Supabase calls that can't be
 * exercised without a live instance.
 *
 * app.knowledge.tsx deliberately follows the same trust model already used
 * by app.business.tsx for services/faqs/rules: direct browser Supabase
 * calls, scoped to the caller's own business/organization (resolved via
 * workspaceQuery, itself RLS-scoped through organization_members), with
 * tenant isolation enforced by knowledge_documents' RLS policy ("tenant
 * knowledge", is_org_member) — not by anything in this file. These tests
 * prove this route never widens that trust model (no raw/unscoped writes,
 * no client-supplied organization_id override, no free-text category).
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.knowledge.tsx"),
  "utf8",
);

describe("tenant scoping — every write is scoped to the caller's own business/organization", () => {
  test("insert sets organization_id/business_id from the resolved business, never a bare literal or client input", () => {
    const idx = src.indexOf('.from("knowledge_documents").insert(');
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 300);
    assert.match(block, /organization_id:\s*business\.organization_id/);
    assert.match(block, /business_id:\s*business\.id/);
  });

  test("update calls are scoped by row id only — never by a client-suppliable organization_id/business_id (RLS is the tenant boundary, not this file)", () => {
    let searchFrom = 0;
    let found = 0;
    for (;;) {
      const idx = src.indexOf('.from("knowledge_documents")', searchFrom);
      if (idx === -1) break;
      const block = src.slice(idx, idx + 400);
      if (block.includes(".update(")) {
        found += 1;
        assert.match(block, /\.eq\("id",/, "every update must be scoped by row id");
        assert.doesNotMatch(
          block,
          /organization_id:|business_id:/,
          "an update must never allow re-parenting a row to a different org/business",
        );
      }
      searchFrom = idx + 1;
    }
    assert.ok(found >= 2, "expected at least the save-edit and toggle-status update call sites");
  });

  test("delete is scoped by row id, relying on the same RLS policy as every other write in this file", () => {
    const idx = src.indexOf('.from("knowledge_documents").delete()');
    assert.ok(idx > -1);
    assert.match(src.slice(idx, idx + 80), /\.eq\("id", deleteTarget\.id\)/);
  });
});

describe("category is a closed set, never free text", () => {
  test("insert's source_type comes from the fixed per-tab category value, not a user-typed field", () => {
    const idx = src.indexOf('.from("knowledge_documents").insert(');
    const block = src.slice(idx, idx + 300);
    assert.match(block, /source_type:\s*category/);
  });

  test("every tab is rendered from KNOWLEDGE_CATEGORIES, not an ad-hoc list duplicated in this file", () => {
    assert.match(
      src,
      /import\s*\{[\s\S]*KNOWLEDGE_CATEGORIES[\s\S]*\}\s*from\s*"@\/lib\/knowledge-categories"/,
    );
    assert.match(src, /KNOWLEDGE_CATEGORIES\.map\(/);
  });
});

describe("delete requires confirmation, never a direct destructive click", () => {
  test("the trash icon opens a confirmation dialog (onRequestDelete/setDeleteTarget), not an immediate delete call", () => {
    assert.doesNotMatch(
      src,
      /onClick=\{\(\) => onRequestDelete\(row\)\}[\s\S]{0,10}>\s*<Trash2[\s\S]{0,80}confirmDelete/,
    );
    const deleteButtonIdx = src.indexOf("onRequestDelete(row)");
    assert.ok(deleteButtonIdx > -1);
    assert.match(src, /AlertDialog\s/);
    assert.match(src, /open=\{deleteTarget !== null\}/);
    const confirmIdx = src.indexOf("async function confirmDelete()");
    assert.ok(confirmIdx > -1);
    // confirmDelete must be reachable only from inside the dialog's action button.
    const dialogActionIdx = src.indexOf("AlertDialogAction", src.indexOf("<AlertDialog "));
    const confirmCallIdx = src.indexOf("void confirmDelete()");
    assert.ok(dialogActionIdx > -1 && confirmCallIdx > -1 && confirmCallIdx > dialogActionIdx);
  });
});

describe("enable/disable toggle only ever writes the two known status values", () => {
  test("toggleDocument computes nextStatus from KNOWLEDGE_ENABLED_STATUS/KNOWLEDGE_DISABLED_STATUS, never a literal string", () => {
    const idx = src.indexOf("async function toggleDocument(");
    const block = src.slice(idx, idx + 400);
    assert.match(block, /KNOWLEDGE_DISABLED_STATUS/);
    assert.match(block, /KNOWLEDGE_ENABLED_STATUS/);
    assert.doesNotMatch(block, /status:\s*"(ready|disabled|archived|error)"/);
  });
});

describe("loading and empty states", () => {
  test("shows LoadingState while the workspace/business hasn't resolved yet", () => {
    assert.match(src, /if \(wsLoading \|\| !business\) return <LoadingState/);
  });

  test("each category panel shows LoadingState while fetching and EmptyState when a category has no rows", () => {
    assert.match(src, /loading \? \(\s*\n\s*<LoadingState/);
    assert.match(src, /<EmptyState/);
  });
});

describe("no server function / new backend introduced — reuses the existing browser+RLS pattern, not agent.functions.ts-style createServerFn", () => {
  test("this file contains no createServerFn — it is a plain route component like app.business.tsx", () => {
    assert.doesNotMatch(src, /createServerFn/);
  });

  test("imports the shared workspaceQuery/knowledgeQuery from workspace.ts rather than duplicating query logic", () => {
    assert.match(
      src,
      /import\s*\{[\s\S]*workspaceQuery[\s\S]*knowledgeQuery[\s\S]*\}\s*from\s*"@\/lib\/workspace"/,
    );
  });
});
