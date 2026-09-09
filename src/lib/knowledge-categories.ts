/**
 * Phase 4 (Customer Knowledge Base) repurposes the existing tenant-scoped
 * knowledge_documents table (base migration) instead of creating a new one.
 * That table's `source_type` column has no CHECK constraint and is not
 * branched on anywhere else in the app, so it doubles as a lightweight
 * category tag here. Its `status` column (already filtered to "ready" by
 * agent-service.server.ts's loadSnapshot) doubles as the enable/disable
 * flag — a document with status "disabled" is automatically excluded from
 * the compiled agent instructions with zero changes to that pipeline.
 *
 * This table stays completely separate from public_knowledge_base (the
 * global, non-tenant table behind the public website AI) — different
 * table, different RLS model, never joined or unioned.
 */

export const KNOWLEDGE_CATEGORIES = [
  { value: "staff", label: "Staff" },
  { value: "policy", label: "Policies" },
  { value: "appointment", label: "Appointments" },
  { value: "custom", label: "Custom" },
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number]["value"];

const CATEGORY_VALUES = new Set<string>(KNOWLEDGE_CATEGORIES.map((c) => c.value));

export function isKnowledgeCategory(value: string): value is KnowledgeCategory {
  return CATEGORY_VALUES.has(value);
}

const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  KNOWLEDGE_CATEGORIES.map((c) => [c.value, c.label]),
);

/** Anything outside the known set — including knowledge_documents' pre-Phase-4
 * default of "text" — renders as "Other" rather than being rejected, since
 * older rows must keep displaying. */
export function knowledgeCategoryLabel(sourceType: string | null | undefined): string {
  return CATEGORY_LABELS[sourceType ?? ""] ?? "Other";
}

export const KNOWLEDGE_ENABLED_STATUS = "ready";
export const KNOWLEDGE_DISABLED_STATUS = "disabled";

export function isKnowledgeEnabled(status: string | null | undefined): boolean {
  return status === KNOWLEDGE_ENABLED_STATUS;
}
