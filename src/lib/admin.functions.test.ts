import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for Phase 2's Customer 360 data additions to
 * getCustomerDetail (admin.functions.ts). Source-scanned like every other
 * createServerFn handler in this codebase (see sarvam-admin.functions.test.ts,
 * telephony-admin.functions.test.ts) — this repo's Node-native test runner
 * cannot safely import/execute createServerFn modules or reach a live
 * Supabase instance.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "admin.functions.ts"),
  "utf8",
);

function extractFn(name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `expected to find export const ${name}`);
  const nextExportIdx = src.indexOf("\nexport const ", start + 1);
  return nextExportIdx > -1 ? src.slice(start, nextExportIdx) : src.slice(start);
}

describe("getCustomerDetail — platform-admin gate runs before any DB read", () => {
  const fnSrc = extractFn("getCustomerDetail");

  test("gates on assertPlatformAdmin(customers.read) before the first Supabase call", () => {
    const adminCallText = 'assertPlatformAdmin(context.supabase, context.userId, "customers.read")';
    const adminIdx = fnSrc.indexOf(adminCallText);
    assert.ok(adminIdx > -1);
    const beforeGate = fnSrc.slice(0, adminIdx);
    assert.equal(beforeGate.includes(".from("), false, "must not touch the database before the admin gate");
  });
});

describe("getCustomerDetail — every query is tenant-scoped to the requested orgId", () => {
  const fnSrc = extractFn("getCustomerDetail");

  // Every .from("<table>") in this handler must be followed (within a
  // reasonable window) by a scoping clause keyed off orgId, EXCEPT the
  // organizations lookup itself (scoped by .eq("id", orgId)) and the
  // downstream profiles lookup (scoped by member ids already derived from
  // an org-scoped query, not a raw table scan).
  const scopedTables = [
    "businesses",
    "subscriptions",
    "organization_members",
    "phone_numbers",
    "organization_feature_locks",
    "organization_entitlements",
    "wallet_transactions",
    "payments",
    "invoices",
    "call_logs",
    "agent_configs",
    "agent_versions",
    "audit_logs",
  ];

  for (const table of scopedTables) {
    test(`${table} query is scoped by organization_id === orgId`, () => {
      // call_logs appears twice (recent calls + month-usage aggregate) —
      // require every occurrence to be org-scoped, not just the first.
      let searchFrom = 0;
      let found = 0;
      for (;;) {
        const idx = fnSrc.indexOf(`.from("${table}")`, searchFrom);
        if (idx === -1) break;
        found += 1;
        const windowSrc = fnSrc.slice(idx, idx + 250);
        assert.match(
          windowSrc,
          /\.eq\("organization_id", orgId\)/,
          `${table} occurrence at index ${idx} must scope by organization_id === orgId`,
        );
        searchFrom = idx + 1;
      }
      assert.ok(found > 0, `expected at least one .from("${table}") in getCustomerDetail`);
    });
  }

  test("the organizations row itself is looked up by id === orgId, not scanned", () => {
    const idx = fnSrc.indexOf('.from("organizations")');
    assert.ok(idx > -1);
    assert.match(fnSrc.slice(idx, idx + 150), /\.eq\("id", orgId\)/);
  });
});

describe("getCustomerDetail — Phase 2 additions are real, not fabricated", () => {
  const fnSrc = extractFn("getCustomerDetail");

  test("usage aggregates are computed from real call_logs rows scoped to this month, not invented", () => {
    assert.match(fnSrc, /gte\("started_at", startOfMonth\.toISOString\(\)\)/);
    assert.match(fnSrc, /callsToday:\s*todayCalls\.length/);
    assert.match(fnSrc, /callsThisMonth:\s*monthCalls\.length/);
    assert.match(fnSrc, /minutesToday:\s*minutesOf\(todayCalls\)/);
    assert.match(fnSrc, /minutesThisMonth:\s*minutesOf\(monthCalls\)/);
  });

  test("today's calls are a subset of this month's calls (filtered from the same fetched rows), not a second guess", () => {
    assert.match(
      fnSrc,
      /const todayCalls = monthCalls\.filter\(\(c\) => c\.started_at >= startOfDay\.toISOString\(\)\)/,
    );
  });

  test("lastPublish comes from a real agent_versions row (status active), not the agent_configs row itself", () => {
    const idx = fnSrc.indexOf('.from("agent_versions")');
    assert.ok(idx > -1);
    const block = fnSrc.slice(idx, idx + 200);
    assert.match(block, /select\("version, created_at"\)/);
    assert.match(block, /eq\("status", "active"\)/);
  });

  test("the enriched calls query includes admin-only economics fields (customer_charge, provider_cost) — safe because this is a service_role, platform-admin-gated read, not the customer-facing grant", () => {
    const idx = fnSrc.indexOf('.from("call_logs")');
    assert.ok(idx > -1);
    const block = fnSrc.slice(idx, idx + 400);
    assert.match(block, /customer_charge/);
    assert.match(block, /provider_cost/);
  });
});

describe("Customer 360 route reuses getProfitAnalytics for finance instead of re-deriving revenue/margin", () => {
  test("admin.customers.$orgId.tsx imports and calls getProfitAnalytics, not a new finance computation", () => {
    const routeSrc = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "routes",
        "admin.customers.$orgId.tsx",
      ),
      "utf8",
    );
    assert.match(routeSrc, /import \{ getProfitAnalytics \} from "@\/lib\/admin-finance\.functions"/);
    assert.match(routeSrc, /profit\?\.rows\.find\(\(r\) => r\.orgId === org\.id\)/);
  });
});
