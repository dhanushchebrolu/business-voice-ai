/**
 * Message Template checks shared by every path that sends a template (the
 * business-message sender and the staff conversation sender). A template is
 * only usable when this number's synced registry row says it is APPROVED,
 * of the category the message needs, with positional parameters matching
 * the message. Registry rows come from Meta via syncTemplates — never from
 * an environment variable or a caller's say-so.
 */

export type TemplateCategory = "UTILITY" | "MARKETING";

export type TemplateFailureCode =
  | "template_not_approved"
  | "template_wrong_category"
  | "template_named_params"
  | "template_param_mismatch";

export interface TemplateRow {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  body_text: string | null;
  body_param_count: number;
}

export const TEMPLATE_COLUMNS = "id, name, language, status, category, body_text, body_param_count";

/** Positional body parameters ({{1}}, {{2}}…). Named parameters ({{name}}) aren't supported by this sender. */
export function countBodyParams(bodyText: string | null): { count: number; named: boolean } {
  if (!bodyText) return { count: 0, named: false };
  const vars = [...bodyText.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!);
  const named = vars.some((v) => !/^\d+$/.test(v));
  return { count: new Set(vars).size, named };
}

/** Why this registry row can't carry this message, or null when it can. */
export function templateProblem(
  template: TemplateRow,
  category: TemplateCategory,
  paramCount: number,
  forWhat: string,
): { code: TemplateFailureCode; problem: string } | null {
  if (template.status !== "APPROVED") {
    return {
      code: "template_not_approved",
      problem: `Template "${template.name}" is ${template.status} at Meta, not APPROVED.`,
    };
  }
  if (template.category !== category) {
    return {
      code: "template_wrong_category",
      problem: `${forWhat} needs a ${category} template; "${template.name}" is ${template.category}.`,
    };
  }
  if (countBodyParams(template.body_text).named) {
    return {
      code: "template_named_params",
      problem: `Template "${template.name}" uses named parameters, which aren't supported.`,
    };
  }
  if (template.body_param_count !== paramCount) {
    return {
      code: "template_param_mismatch",
      problem: `Template "${template.name}" expects ${template.body_param_count} body parameter(s); this message has ${paramCount}.`,
    };
  }
  return null;
}
