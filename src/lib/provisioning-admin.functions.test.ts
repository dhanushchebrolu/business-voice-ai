import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * createServerFn handlers cannot run under this test runner, so — as in the
 * other *.functions.test.ts files — these are source checks of the
 * authorization and redaction rules. The logic they delegate to is tested
 * behaviorally (provisioning-view.test.ts, sarvam-agent-registration.server.test.ts,
 * provisioning-pipeline.server.test.ts).
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "provisioning-admin.functions.ts"), "utf8");
const detailPage = readFileSync(
  join(here, "..", "routes", "admin.provisioning.$orgId.tsx"),
  "utf8",
);
const queuePage = readFileSync(join(here, "..", "routes", "admin.provisioning.index.tsx"), "utf8");

function extractFn(name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `${name} not found`);
  const next = src.indexOf("export const ", start + 10);
  return src.slice(start, next > -1 ? next : undefined);
}

describe("admin authorization", () => {
  for (const [name, permission] of [
    ["listProvisioningQueue", "customers.read"],
    ["getProvisioningDetail", "customers.read"],
    ["registerCustomerSarvamAgent", "agents.write"],
  ] as const) {
    test(`${name} requires a signed-in user and checks platform-admin (${permission}) before any data access`, () => {
      const fn = extractFn(name);
      assert.match(fn, /\.middleware\(\[requireSupabaseAuth\]\)/);
      const authIdx = fn.indexOf(
        `assertPlatformAdmin(context.supabase, context.userId, "${permission}")`,
      );
      assert.ok(authIdx > -1, "platform-admin check present");
      for (const access of ["supabaseAdmin", "loadDetail("])
        if (fn.includes(access))
          assert.ok(authIdx < fn.indexOf(access), `${access} only after the admin check`);
    });
  }
});

describe("customer isolation", () => {
  test("registration is scoped to the customer's own agent and audited", () => {
    const fn = extractFn("registerCustomerSarvamAgent");
    assert.match(fn, /organizationId: data\.orgId/);
    assert.match(fn, /agentConfigId: detail\.agent\.id/);
    assert.match(fn, /registrationGate\(detail\._gate, data\.sarvamAppId\)/);
    assert.match(fn, /action: "SARVAM_AGENT_REGISTERED"/);
  });

  test("every per-customer read filters by the requested organization", () => {
    const loader = src.slice(
      src.indexOf("async function loadDetail"),
      src.indexOf("export const getProvisioningDetail"),
    );
    for (const table of [
      "agent_configs",
      "phone_numbers",
      "telephony_connections",
      "provisioning_runs",
    ]) {
      const idx = loader.indexOf(`.from("${table}")`);
      assert.ok(idx > -1, table);
      assert.match(loader.slice(idx, idx + 400), /\.eq\("organization_id", orgId\)/, table);
    }
  });
});

describe("secret redaction", () => {
  test("integration credentials are read with safe columns only — never the token hash", () => {
    assert.doesNotMatch(src.replace(/\/\*\*[\s\S]*?\*\//g, ""), /token_hash/);
    const cols = /INTEGRATION_SAFE_COLUMNS =\s*"([^"]+)"/.exec(src)![1]!;
    assert.ok(cols.includes("token_prefix"));
    assert.ok(!/\btoken_hash\b|\btoken\b(?!_)/.test(cols));
    assert.match(src, /\.select\(INTEGRATION_SAFE_COLUMNS\)/);
  });

  test("the detail page never renders a credential value; issuing reuses the once-only panel", () => {
    assert.match(detailPage, /<SarvamIntegrationPanel orgId=\{orgId\} \/>/);
    assert.doesNotMatch(detailPage, /token_hash|credential\.token\b|\.token\}/);
  });
});

describe("regressions found in browser testing (Phase 3.5)", () => {
  test("queue search is debounced: the query key uses the settled value, not every keystroke", () => {
    assert.match(
      queuePage,
      /setTimeout\(\(\) => setQuery\(search\.trim\(\)\), SEARCH_DEBOUNCE_MS\)/,
    );
    assert.match(queuePage, /queryKey: \["admin-provisioning-queue", status, query\]/);
    assert.doesNotMatch(queuePage, /queryKey: \["admin-provisioning-queue", status, search\]/);
  });

  test("a failed attempt (e.g. deployment creation) is explained in the deployment section", () => {
    assert.match(
      detailPage,
      /latest\?\.status === "failed" \? \(latest\.last_error \?\? latest\.note\)/,
    );
    assert.match(detailPage, /data-testid="latest-run-error"/);
  });
});

describe("UI state rendering", () => {
  test("the activation action is disabled unless every prerequisite passes, with the reasons shown", () => {
    assert.match(detailPage, /disabled=\{!activation\.allowed\}/);
    assert.match(detailPage, /activation\.reasons\.join/);
  });

  test("the detail page shows the checklist, missing requirements, expected vs actual and job history", () => {
    assert.match(detailPage, /data-testid="provisioning-checklist"/);
    assert.match(detailPage, /Missing onboarding requirements/);
    assert.match(detailPage, /<th>Expected<\/th>/);
    assert.match(detailPage, /<th>Actual<\/th>/);
    assert.match(detailPage, /title="Job history"/);
    assert.match(detailPage, /aria-label=\{`Copy \$\{label\}`\}/);
  });

  test("retry goes through retryProvisioning (one active run, no duplicate deployment or number)", () => {
    assert.match(
      detailPage,
      /import \{ retryProvisioning \} from "@\/lib\/telephony-admin\.functions"/,
    );
    assert.match(detailPage, /await retry\(\{ data: \{ orgId, reason \} \}\)/);
  });

  test("the queue has search, status filters and links each row to its detail page", () => {
    assert.match(queuePage, /aria-label="Search customers or numbers"/);
    assert.match(queuePage, /QUEUE_FILTERS/);
    assert.match(queuePage, /to="\/admin\/provisioning\/\$orgId"/);
  });
});

describe("voice & language integration (Phase 4A)", () => {
  test("detail reads the customer's own voice settings and feeds them into the config and gate", () => {
    const loader = src.slice(
      src.indexOf("async function loadDetail"),
      src.indexOf("export const getProvisioningDetail"),
    );
    const idx = loader.indexOf('.from("agent_voice_language_settings")');
    assert.ok(idx > -1);
    assert.match(loader.slice(idx, idx + 500), /\.eq\("organization_id", orgId\)/);
    assert.match(loader, /buildUniversalAgentConfig\(snapshot, voiceLanguage \?\? null\)/);
    assert.match(loader, /voiceLanguage: \{\s*problem:/);
  });

  test("registration records the voice settings as applied to that version, scoped and audited", () => {
    const fn = extractFn("registerCustomerSarvamAgent");
    const idx = fn.indexOf('.from("agent_voice_language_settings")');
    assert.ok(idx > fn.indexOf("applySarvamAgentMapping("), "after the mapping");
    const block = fn.slice(idx, idx + 600);
    assert.match(block, /applied_sarvam_app_version: data\.sarvamAppVersion/);
    assert.match(block, /\.eq\("organization_id", data\.orgId\)/);
    assert.match(fn, /action: "VOICE_LANGUAGE_SETTINGS_APPLIED"/);
  });

  test("the detail page shows the voice/language config with copy, and embeds the settings panel", () => {
    assert.match(detailPage, /data-testid="voice-language-config"/);
    assert.match(detailPage, /label="voice and language configuration"/);
    assert.match(detailPage, /<VoiceLanguagePanel orgId=\{orgId\} \/>/);
  });
});

describe("Phase 5 admin actions and dashboard", () => {
  const fn = (name: string) => {
    const i = src.indexOf(`export const ${name}`);
    assert.ok(i > -1, name);
    const next = src.indexOf("export const ", i + 1);
    return src.slice(i, next === -1 ? undefined : next);
  };
  const voiceSrc = readFileSync(join(here, "voice-language-settings.functions.ts"), "utf8");

  test("confirming a number and clearing a block need numbers.write, a reason, and are audited", () => {
    for (const [name, action] of [
      ["confirmSarvamNumber", "SARVAM_NUMBER_CONFIRMED"],
      ["clearAdmissionBlock", "INBOUND_ADMISSION_BLOCK_CLEARED"],
    ] as const) {
      const h = fn(name);
      assert.match(
        h,
        /assertPlatformAdmin\(context\.supabase, context\.userId, "numbers\.write"\)/,
      );
      assert.match(h, /A reason is required/);
      assert.match(h, new RegExp(`action: "${action}"`));
      assert.match(
        h,
        /\.eq\("organization_id", data\.orgId\)/,
        `${name} is scoped to the customer`,
      );
    }
  });

  test("confirming a number never rents, buys or claims one: it only stamps the existing row", () => {
    const h = fn("confirmSarvamNumber");
    assert.match(h, /sarvam_number_confirmed_at/);
    assert.doesNotMatch(h, /insert\(|provisionNumber|claim|purchase|rent/i);
  });

  test("registration records the Sarvam agent id AND version as applied, and re-verifies an existing deployment", () => {
    const h = fn("registerCustomerSarvamAgent");
    assert.match(h, /applied_sarvam_app_id: data\.sarvamAppId\.trim\(\)/);
    assert.match(h, /applied_sarvam_app_version: data\.sarvamAppVersion/);
    assert.match(h, /runProvisioning\(/);
  });

  test("marking voice applied records the agent the version belongs to", () => {
    const i = voiceSrc.indexOf("export const markVoiceLanguageApplied");
    const h = voiceSrc.slice(i);
    assert.match(h, /applied_sarvam_app_id: agent\.sarvam_app_id/);
    assert.match(h, /\.eq\("organization_id", data\.orgId\)/);
  });

  test("saving voice settings resets both applied fields to pending", () => {
    const i = voiceSrc.indexOf("export const saveVoiceLanguageSettings");
    const h = voiceSrc.slice(i, voiceSrc.indexOf("export const markVoiceLanguageApplied"));
    assert.match(h, /applied_sarvam_app_id: null/);
    assert.match(h, /applied_sarvam_app_version: null/);
  });

  test("audit history reads only safe columns", () => {
    const i = src.indexOf('.from("audit_logs")');
    const sel = src.slice(i, src.indexOf(")", src.indexOf(".select(", i)) + 1);
    assert.match(sel, /"id, action, admin_email, reason, created_at"/);
    assert.doesNotMatch(sel, /old_value|new_value|ip_address/);
  });

  test("the detail page shows confirmation, verified mapping, admission state and audit history, and documents the exposure window", () => {
    assert.match(detailPage, /Confirm number exists in Sarvam/);
    assert.match(detailPage, /verified mapping/);
    assert.match(detailPage, /business data blocked/);
    assert.match(detailPage, /Clear admission block/);
    assert.match(detailPage, /title="Audit history"/);
    assert.match(detailPage, /for a few seconds after creation calls can still reach the agent/);
    assert.doesNotMatch(detailPage, /Vobiz/);
  });
});

describe("Phase 5 fixes: live customers and reuse safety", () => {
  const fnOf = (source: string, name: string) => {
    const i = source.indexOf(`export const ${name}`);
    assert.ok(i > -1, name);
    const next = source.indexOf("export const ", i + 1);
    return source.slice(i, next === -1 ? undefined : next);
  };
  const sarvamAdminSrc = readFileSync(join(here, "sarvam-admin.functions.ts"), "utf8");

  test("Map Sarvam app routes a live customer through verify-first remapping before any direct mapping", () => {
    const h = fnOf(sarvamAdminSrc, "setSarvamAppMapping");
    const live = h.indexOf("findLiveNumber(");
    const remap = h.indexOf("remapLiveAgent(");
    const direct = h.indexOf("applySarvamAgentMapping(supabaseAdmin,");
    assert.ok(live > -1 && remap > live && direct > remap);
    assert.match(h, /if \(result\.outcome !== "verified"\) throw new Error\(result\.detail\)/);
    assert.match(h, /SARVAM_APP_MAPPING_NOT_APPLIED/);
  });

  test("registration of a live customer also goes verify-first and never re-maps directly", () => {
    const h = fnOf(src, "registerCustomerSarvamAgent");
    assert.match(h, /findLiveNumber\(/);
    assert.match(h, /remapLiveAgent\(/);
    assert.match(h, /const mapped = live\s*\?/);
  });

  test("re-verify live deployment: numbers.write, a reason, audited, read-only re-verification of the current mapping", () => {
    const h = fnOf(src, "reverifyLiveDeployment");
    assert.match(h, /assertPlatformAdmin\(context\.supabase, context\.userId, "numbers\.write"\)/);
    assert.match(h, /A reason is required/);
    assert.match(h, /LIVE_DEPLOYMENT_REVERIFIED/);
    assert.match(h, /appVersion: agent\.sarvam_app_version/);
  });

  test("a number that already has a deployment can never be marked ClickAI-provisioned by confirmation", () => {
    const h = fnOf(src, "confirmSarvamNumber");
    assert.match(h, /if \(number\.provider_deployment_id\)/);
    assert.match(h, /\.is\("provider_deployment_id", null\)/);
  });

  test("the detail page offers Re-verify live deployment only for a live number", () => {
    assert.match(detailPage, /Re-verify live deployment/);
    assert.match(detailPage, /reverifyLiveDeployment/);
  });
});
