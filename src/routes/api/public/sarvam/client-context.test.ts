import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the Sarvam client-context route (Task #94).
 * createFileRoute-based handler, so — consistent with this repo's
 * established convention — a source scan.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "client-context.ts"),
  "utf8",
);

describe("auth and configuration — fails closed", () => {
  test("returns 503 when SARVAM_CONTEXT_SECRET is not configured, before reading any query parameter", () => {
    const secretCheckIdx = src.indexOf('process.env["SARVAM_CONTEXT_SECRET"]');
    const firstParamReadIdx = src.indexOf("url.searchParams.get(");
    assert.ok(secretCheckIdx > -1 && firstParamReadIdx > -1);
    assert.ok(secretCheckIdx < firstParamReadIdx);
    const guardIdx = src.indexOf("if (!secret) {");
    const guardEnd = src.indexOf("}", guardIdx);
    assert.match(src.slice(guardIdx, guardEnd), /status: 503/);
  });

  test("verify_token is compared with constantTimeEquals, not ===", () => {
    assert.match(src, /import \{ constantTimeEquals \} from/);
    assert.match(src, /constantTimeEquals\(provided, secret\)/);
    assert.doesNotMatch(src, /provided === secret/);
  });

  test("a missing or wrong verify_token is rejected before any database query", () => {
    const authIdx = src.indexOf("constantTimeEquals(provided, secret)");
    const dbImportIdx = src.indexOf('await import("@/integrations/supabase/client.server")');
    assert.ok(authIdx > -1 && dbImportIdx > -1);
    assert.ok(authIdx < dbImportIdx);
    assert.match(src, /status: 401/);
  });
});

describe("tenant resolution — never trusts a caller-supplied organization id", () => {
  test("only phone_number/connection_id/deployment_id are read from the request — no organization_id/org_id parameter anywhere", () => {
    assert.match(src, /"phone_number"/);
    assert.match(src, /"connection_id"/);
    assert.match(src, /"deployment_id"/);
    assert.doesNotMatch(src, /"organization_id"|"org_id"/);
  });

  test("rejects the request when none of the three identifiers is supplied", () => {
    assert.match(src, /!phoneNumber && !connectionId && !deploymentId/);
    assert.match(src, /status: 400/);
  });

  test("resolves the organization via resolveOrganizationForSarvamContext, never constructs one from raw input", () => {
    assert.match(src, /await resolveOrganizationForSarvamContext\(supabaseAdmin, \{/);
    const guardIdx = src.indexOf("if (!organizationId) {");
    const guardEnd = src.indexOf("}", guardIdx);
    assert.match(src.slice(guardIdx, guardEnd), /status: 404/);
  });
});

describe("rate limiting", () => {
  test("checkSarvamContextRateLimit runs before any database resolution, keyed by the resolved identifier not caller IP", () => {
    const rateLimitIdx = src.indexOf("checkSarvamContextRateLimit(");
    const resolveIdx = src.indexOf("resolveOrganizationForSarvamContext(");
    assert.ok(rateLimitIdx > -1 && resolveIdx > -1);
    assert.ok(rateLimitIdx < resolveIdx);
    assert.match(src, /rateLimitKey = deploymentId \?\? connectionId \?\? phoneNumber/);
  });

  test("a rate-limited request is rejected with 429 and a retry-after header", () => {
    assert.match(src, /if \(!decision\.allowed\)/);
    assert.match(src, /status: 429/);
    assert.match(src, /"retry-after":\s*String\(decision\.retryAfterSeconds\)/);
  });
});

describe("logging never includes the secret", () => {
  test("the only console.log call logs the resolved organization id and which identifier type was used — never verify_token/secret/provided", () => {
    const logIdx = src.indexOf('console.log(\n          "sarvam_context:resolve"');
    assert.ok(logIdx > -1, "expected the sarvam_context:resolve log line");
    const logCallEnd = src.indexOf(");", logIdx);
    const logCall = src.slice(logIdx, logCallEnd);
    assert.doesNotMatch(logCall, /secret|provided|verify_token/);
  });
});

describe("response contract", () => {
  test("a successful response returns the context object as JSON with a content-type header", () => {
    assert.match(src, /JSON\.stringify\(context\)/);
    assert.match(src, /"content-type":\s*"application\/json"/);
  });

  test("returns 404 (not a fabricated empty context) when the resolved organization has no business record yet", () => {
    const buildIdx = src.indexOf("await buildSarvamClientContext(");
    const guardIdx = src.indexOf("if (!context) {", buildIdx);
    const guardEnd = src.indexOf("}", guardIdx);
    assert.ok(guardIdx > buildIdx);
    assert.match(src.slice(guardIdx, guardEnd), /status: 404/);
  });
});
