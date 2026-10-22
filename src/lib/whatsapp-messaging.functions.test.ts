import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * createServerFn handlers can't be executed by this test runner (same
 * convention as the other *.functions.ts scans), so the tenant, role,
 * audit and credential rules are checked in the source.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "whatsapp-messaging.functions.ts"),
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
  "getWhatsAppMessagingOverview",
  "setWhatsAppNotificationSettings",
  "syncWhatsAppTemplates",
  "setWhatsAppTemplatePurpose",
  "recordWhatsAppContactConsent",
  "setWhatsAppSuppression",
  "createWhatsAppCampaign",
  "changeWhatsAppCampaign",
];
const WRITES = ALL.slice(1);

describe("tenant isolation", () => {
  test("every handler requires auth and takes the organization from the caller's membership", () => {
    for (const name of ALL) {
      const body = handler(name);
      assert.match(body, /\.middleware\(\[requireSupabaseAuth\]\)/, name);
      assert.match(body, /await resolveMembership\(context\)/, name);
    }
    assert.match(code, /\.eq\("user_id", context\.userId\)/);
  });

  test("no handler accepts an organization id from the browser", () => {
    for (const name of ALL) {
      const body = handler(name);
      const validator = /inputValidator\(([\s\S]*?)\)\s*\.handler/.exec(body)?.[1] ?? "";
      assert.doesNotMatch(validator, /organization/i, name);
    }
    assert.doesNotMatch(code, /data\.organizationId/);
  });

  test("every service-role query is filtered by the membership's organization", () => {
    for (const name of WRITES) {
      const body = handler(name);
      const adminQueries = body.split("supabaseAdmin").length - 1;
      if (adminQueries === 0) continue;
      assert.match(
        body,
        /organization_id", (membership\.organization_id|org)\)|organizationId: (membership\.organization_id|org)/,
        name,
      );
    }
  });

  test("reads go through the caller's RLS-scoped client", () => {
    const body = handler("getWhatsAppMessagingOverview");
    assert.match(body, /context\.supabase\s*\.from\("whatsapp_connections"\)/);
  });
});

describe("roles", () => {
  test("each write checks the role before any service-role access", () => {
    const expected: Record<string, string> = {
      setWhatsAppNotificationSettings: "OWNER_ADMIN",
      setWhatsAppTemplatePurpose: "OWNER_ADMIN",
      setWhatsAppSuppression: "OWNER_ADMIN",
      syncWhatsAppTemplates: "MANAGERS",
      createWhatsAppCampaign: "MANAGERS",
      changeWhatsAppCampaign: "MANAGERS",
      recordWhatsAppContactConsent: "WRITERS",
    };
    for (const [name, roles] of Object.entries(expected)) {
      const body = handler(name);
      const guard = body.indexOf(`requireRole(membership.role, ${roles})`);
      const admin = body.indexOf("supabaseAdmin");
      assert.ok(guard > -1, `${name} guard`);
      assert.ok(admin === -1 || guard < admin, `${name} guard before service role`);
    }
    assert.match(code, /const WRITERS: Role\[\] = \["owner", "admin", "manager", "staff"\]/);
  });
});

describe("consent and policy", () => {
  test("turning notifications on requires a recorded consent basis", () => {
    assert.match(
      handler("setWhatsAppNotificationSettings"),
      /data\.enabled && \(!data\.consentBasis \|\| data\.consentBasis\.length < 20\)/,
    );
  });
  test("a staff-recorded opt-in requires evidence", () => {
    assert.match(
      handler("recordWhatsAppContactConsent"),
      /data\.action === "opt_in" && \(!data\.evidence \|\| data\.evidence\.length < 10\)/,
    );
  });
  test("campaigns only use APPROVED MARKETING templates", () => {
    assert.match(
      handler("createWhatsAppCampaign"),
      /template\.status !== "APPROVED" \|\| template\.category !== "MARKETING"/,
    );
  });
  test("a campaign's time zone must be a real IANA zone", () => {
    assert.match(code, /timezone: z\.string\(\)\.max\(64\)\.refine\(isValidTimeZone/);
  });
  test("writes are audited", () => {
    for (const name of WRITES.filter(
      (n) => n !== "syncWhatsAppTemplates" && n !== "changeWhatsAppCampaign",
    )) {
      assert.match(handler(name), /writeAuditLog\(/, name);
    }
  });
});

describe("credentials never reach the browser", () => {
  test("no token or secret column is selected or returned", () => {
    assert.doesNotMatch(code, /access_token|ciphertext|app_secret/i);
  });
});
