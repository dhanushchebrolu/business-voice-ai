import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * createServerFn handlers can't be executed by this test runner (same
 * convention as the other *.functions.ts scans), so the tenant and
 * credential rules are checked in the source.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "whatsapp-conversations.functions.ts"),
  "utf8",
);
const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");

function handler(name: string): string {
  const start = code.indexOf(`export const ${name}`);
  assert.ok(start > -1, name);
  const next = code.indexOf("export const ", start + 1);
  return code.slice(start, next === -1 ? undefined : next);
}

const ALL = [
  "listWhatsAppConversations",
  "listWhatsAppMessages",
  "setWhatsAppConversationAi",
  "sendWhatsAppStaffReply",
];
const WRITES = ["setWhatsAppConversationAi", "sendWhatsAppStaffReply"];

describe("tenant isolation", () => {
  test("every handler requires auth and takes the organization from the caller's membership", () => {
    for (const name of ALL) {
      const body = handler(name);
      assert.match(body, /\.middleware\(\[requireSupabaseAuth\]\)/, name);
      assert.match(body, /await resolveMembership\(context\)/, name);
    }
    assert.match(code, /\.eq\("user_id", context\.userId\)/);
  });

  test("no handler accepts an organization or business id from the browser", () => {
    for (const name of ALL) {
      const validator = /inputValidator\(([\s\S]*?)\)\s*\.handler/.exec(handler(name))?.[1] ?? "";
      assert.doesNotMatch(validator, /organization|business/i, name);
    }
    assert.doesNotMatch(code, /data\.organizationId|data\.businessId/);
  });

  test("every query is filtered by the membership's organization", () => {
    for (const name of ALL) {
      assert.match(
        handler(name),
        /organization_id", membership\.organization_id\)|organizationId: membership\.organization_id/,
        name,
      );
    }
  });

  test("reads go through the caller's RLS-scoped client", () => {
    for (const name of ["listWhatsAppConversations", "listWhatsAppMessages"]) {
      assert.match(handler(name), /context\.supabase\s*\.from\(/, name);
      assert.doesNotMatch(handler(name), /supabaseAdmin/, name);
    }
  });

  test("writes are refused for viewers before any service-role access", () => {
    for (const name of WRITES) {
      const body = handler(name);
      const guard = body.indexOf("assertCanWrite(membership.role)");
      const admin = body.indexOf("supabaseAdmin");
      assert.ok(guard > -1 && admin > -1 && guard < admin, name);
    }
    assert.match(code, /role === "viewer"/);
  });
});

describe("credentials never reach the browser", () => {
  test("no handler selects or returns token columns", () => {
    assert.doesNotMatch(code, /access_token|ciphertext|app_secret/i);
  });
});

describe("staff replies", () => {
  test("go through the shared outbound path (window, opt-in, rate limit, idempotency) and pause the AI", () => {
    const body = handler("sendWhatsAppStaffReply");
    assert.match(body, /sendWhatsAppConversationMessage\(/);
    assert.match(body, /idempotencyKey: `staff:\$\{data\.clientRequestId\}`/);
    assert.match(body, /\.update\(\{ ai_enabled: false \}\)/);
    assert.match(code, /body: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(4096\)/);
  });

  test("a refusal after the customer's opt-out says why", () => {
    assert.match(code, /opted_out:\s*"[^"]*opted out[^"]*"/i);
  });

  test("an unconfirmed delivery is reported as 'delivery unknown' (never 'Not sent … retry') and still pauses the AI", () => {
    const body = handler("sendWhatsAppStaffReply");
    const ambiguous = body.indexOf("result.ambiguous");
    const notSent = body.indexOf("`Not sent: ${result.error}`");
    assert.ok(ambiguous > -1 && notSent > -1 && ambiguous < notSent);
    const branch = body.slice(ambiguous, notSent);
    assert.match(branch, /deliveryUnknown: true/);
    assert.match(branch, /may (already )?have reached/i);
    assert.doesNotMatch(branch, /retry/i);
    assert.match(branch, /pauseAi\(\)/);
    assert.match(body, /const pauseAi = \(\) =>[\s\S]*?\.update\(\{ ai_enabled: false \}\)/);
  });
});
