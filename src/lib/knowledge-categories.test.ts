import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_CATEGORIES,
  isKnowledgeCategory,
  knowledgeCategoryLabel,
  isKnowledgeEnabled,
  KNOWLEDGE_ENABLED_STATUS,
  KNOWLEDGE_DISABLED_STATUS,
} from "./knowledge-categories.ts";

describe("KNOWLEDGE_CATEGORIES — the closed set Phase 4 repurposes source_type into", () => {
  test("exactly the four categories not already covered by a dedicated table (business/services/pricing/hours/faqs)", () => {
    assert.deepEqual(
      KNOWLEDGE_CATEGORIES.map((c) => c.value),
      ["staff", "policy", "appointment", "custom"],
    );
  });

  test("isKnowledgeCategory accepts only the known set, rejecting arbitrary/malformed strings", () => {
    for (const c of KNOWLEDGE_CATEGORIES) assert.equal(isKnowledgeCategory(c.value), true);
    for (const bad of [
      "text",
      "STAFF",
      "staff ",
      "'; drop table knowledge_documents; --",
      "",
      "general",
    ]) {
      assert.equal(isKnowledgeCategory(bad), false, `expected "${bad}" to be rejected`);
    }
  });

  test("knowledgeCategoryLabel falls back to 'Other' for legacy/unknown source_type values instead of throwing", () => {
    assert.equal(knowledgeCategoryLabel("staff"), "Staff");
    assert.equal(knowledgeCategoryLabel("policy"), "Policies");
    assert.equal(knowledgeCategoryLabel("appointment"), "Appointments");
    assert.equal(knowledgeCategoryLabel("custom"), "Custom");
    assert.equal(
      knowledgeCategoryLabel("text"),
      "Other",
      "the column's pre-Phase-4 default must not crash rendering",
    );
    assert.equal(knowledgeCategoryLabel(null), "Other");
    assert.equal(knowledgeCategoryLabel(undefined), "Other");
    assert.equal(knowledgeCategoryLabel(""), "Other");
  });
});

describe("enable/disable repurposes knowledge_documents.status, reusing the existing loadSnapshot filter", () => {
  test('only status === \'ready\' counts as enabled — matches agent-service.server.ts\'s .eq("status", "ready") filter exactly', () => {
    assert.equal(KNOWLEDGE_ENABLED_STATUS, "ready");
    assert.equal(isKnowledgeEnabled("ready"), true);
    assert.equal(isKnowledgeEnabled("disabled"), false);
    assert.equal(isKnowledgeEnabled(KNOWLEDGE_DISABLED_STATUS), false);
    assert.equal(isKnowledgeEnabled(null), false);
    assert.equal(isKnowledgeEnabled(undefined), false);
    assert.equal(
      isKnowledgeEnabled("error"),
      false,
      "a document stuck in an error state must not be treated as enabled",
    );
  });
});
