import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The staging helper's guards, run against fixture env files: it must never
 * act on production, never print a value, and never touch Cloudflare
 * without --yes. Only "check" and refused actions run here, so nothing
 * leaves the machine.
 */
const script = join(import.meta.dirname, "staging.mjs");
const STAGING_REF = "abcdefghijklmnopqrst";
const SECRET_MARKER = "do-not-print-this-value";
const STAGING_WORKER_URL = "https://clickai-staging.example-sub.workers.dev";

function complete(overrides = {}) {
  return {
    SUPABASE_URL: `https://${STAGING_REF}.supabase.co`,
    SUPABASE_PUBLISHABLE_KEY: `pub-${SECRET_MARKER}`,
    SUPABASE_SERVICE_ROLE_KEY: `srv-${SECRET_MARKER}`,
    VITE_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`,
    VITE_SUPABASE_PUBLISHABLE_KEY: `pub-${SECRET_MARKER}`,
    META_APP_ID: "1234567890",
    META_APP_SECRET: `meta-${SECRET_MARKER}`,
    META_WHATSAPP_CONFIG_ID: "987654321",
    META_GRAPH_API_VERSION: "v23.0",
    VITE_META_APP_ID: "1234567890",
    VITE_META_WHATSAPP_CONFIG_ID: "987654321",
    VITE_META_GRAPH_API_VERSION: "v23.0",
    WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: `verify-${SECRET_MARKER}`,
    LOVABLE_CRON_SECRET: `cron-${SECRET_MARKER}`,
    SARVAM_API_KEY: `sarvam-${SECRET_MARKER}`,
    TELEPHONY_WEBHOOK_BASE_URL: STAGING_WORKER_URL,
    MEDIA_SESSION_TOKEN_SECRET: `media-${SECRET_MARKER}-0123456789`,
    VOBIZ_AUTH_ID: "MA_TESTAUTHID",
    VOBIZ_AUTH_TOKEN: `vobiz-${SECRET_MARKER}`,
    VOBIZ_PHONE_NUMBER: "+910000000000",
    VOBIZ_WEBHOOK_VERIFY_TOKEN: `vobiz-verify-${SECRET_MARKER}`,
    GOOGLE_CALENDAR_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_CALENDAR_CLIENT_SECRET: `gcal-${SECRET_MARKER}`,
    GOOGLE_CALENDAR_REDIRECT_URI: `${STAGING_WORKER_URL}/api/public/integrations/google-calendar/callback`,
    GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ...overrides,
  };
}

function runWith(env, args, extraProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "staging-helper-test-"));
  const file = join(dir, ".env.staging.local");
  writeFileSync(
    file,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  try {
    const r = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, STAGING_ENV_FILE: file, ...extraProcessEnv },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a complete staging file is READY, shows only the project ref, and prints no value", () => {
  const r = runWith(complete(), ["check"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /READY/);
  assert.match(r.out, new RegExp(`staging Supabase project ref: ${STAGING_REF}`));
  assert.doesNotMatch(r.out, new RegExp(SECRET_MARKER));
  // Without production fingerprints the helper says what it couldn't prove.
  assert.match(r.out, /NOTE {2}no production fingerprints/);
});

// --- voice, telephony, calendar and payment guards ---
/** What an inbound Vobiz call needs: Sarvam plus the three values the Vobiz adapter requires. */
const VOICE_REQUIRED = [
  "SARVAM_API_KEY",
  "VOBIZ_AUTH_ID",
  "VOBIZ_AUTH_TOKEN",
  "VOBIZ_WEBHOOK_VERIFY_TOKEN",
];
/** Optional for a voice-only staging Worker: outbound-only, Exotel-only and Google Calendar settings. */
const VOICE_OPTIONAL = [
  "TELEPHONY_WEBHOOK_BASE_URL",
  "MEDIA_SESSION_TOKEN_SECRET",
  "VOBIZ_PHONE_NUMBER",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
  "GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY",
];
/** A complete file without any optional voice setting: the minimum for a voice-only test. */
function voiceOnly(overrides = {}) {
  const env = complete();
  for (const name of VOICE_OPTIONAL) delete env[name];
  return { ...env, ...overrides };
}

/** check is NOT READY with `message`, deploy --yes is refused, and no value is printed. */
function assertRefused(overrides, message, extraProcessEnv = {}) {
  const label = Object.keys(overrides).join(", ");
  const r = runWith(complete(overrides), ["check"], extraProcessEnv);
  assert.equal(r.status, 2, `${label}: ${r.out}`);
  assert.match(r.out, message, label);
  assert.doesNotMatch(r.out, new RegExp(SECRET_MARKER), label);
  const deploy = runWith(complete(overrides), ["deploy", "--yes"], extraProcessEnv);
  assert.equal(deploy.status, 1, `${label}: ${deploy.out}`);
  assert.match(deploy.out, /REFUSED/);
  assert.doesNotMatch(deploy.out, new RegExp(SECRET_MARKER), label);
}

test("each of the four voice settings an inbound call needs is required", () => {
  for (const name of VOICE_REQUIRED) {
    assertRefused({ [name]: "" }, new RegExp(`MISSING {2}${name}\\b`));
    // Also from the minimal voice-only file.
    const r = runWith(voiceOnly({ [name]: "" }), ["check"]);
    assert.equal(r.status, 2, `${name}: ${r.out}`);
    assert.match(r.out, new RegExp(`MISSING {2}${name}\\b`));
  }
});

test("a voice-only file without Google, outbound or Exotel settings is READY; those are listed as optional", () => {
  const r = runWith(voiceOnly(), ["check"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /READY/);
  assert.doesNotMatch(r.out, /PROBLEM/);
  for (const name of VOICE_OPTIONAL) {
    assert.match(r.out, new RegExp(`MISSING {2}${name} \\(optional\\)`), name);
  }
  assert.doesNotMatch(r.out, new RegExp(SECRET_MARKER));
});

test("optional settings are still validated when set", () => {
  for (const [overrides, message] of [
    [{ TELEPHONY_WEBHOOK_BASE_URL: `${STAGING_WORKER_URL}/` }, /no path or trailing slash/],
    [{ TELEPHONY_WEBHOOK_BASE_URL: "https://klyro.aiblaze-io.workers.dev" }, /klyro/],
    [{ VOBIZ_PHONE_NUMBER: "09876543210" }, /E\.164/],
    [{ MEDIA_SESSION_TOKEN_SECRET: "short" }, /shorter than 32/],
    [
      { GOOGLE_CALENDAR_CLIENT_ID: "test-client.apps.googleusercontent.com" },
      /half-configured: set all four or none \(missing GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_CALENDAR_REDIRECT_URI, GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY\)/,
    ],
  ]) {
    const label = Object.keys(overrides).join(", ");
    const r = runWith(voiceOnly(overrides), ["check"]);
    assert.equal(r.status, 2, `${label}: ${r.out}`);
    assert.match(r.out, message, label);
    assert.doesNotMatch(r.out, new RegExp(SECRET_MARKER), label);
    const deploy = runWith(voiceOnly(overrides), ["deploy", "--yes"]);
    assert.equal(deploy.status, 1, `${label}: ${deploy.out}`);
    assert.match(deploy.out, /REFUSED/);
  }
  // A half-configured Google set is refused from the full file too.
  assertRefused({ GOOGLE_CALENDAR_CLIENT_SECRET: "" }, /Google Calendar is half-configured/);
});

test("the Vobiz verify token must be long and URL-safe, since it travels in the callback URL", () => {
  for (const value of [
    "short-token",
    `${"a".repeat(31)}`,
    `${"a".repeat(32)}&x=1`,
    `${"a".repeat(32)} b`,
  ]) {
    assertRefused(
      { VOBIZ_WEBHOOK_VERIFY_TOKEN: value },
      /VOBIZ_WEBHOOK_VERIFY_TOKEN must be at least 32 URL-safe/,
    );
  }
  assert.equal(
    runWith(voiceOnly({ VOBIZ_WEBHOOK_VERIFY_TOKEN: "A-z_0".repeat(8) }), ["check"]).status,
    0,
  );
});

test("a voice-only file keeps every production and klyro guard", () => {
  for (const [overrides, message] of [
    [{ SUPABASE_URL: "https://eorazvlmqwunmhwviocn.supabase.co" }, /production Supabase project/],
    [
      { VITE_SUPABASE_URL: "https://eorazvlmqwunmhwviocn.supabase.co" },
      /production Supabase project/,
    ],
    [{ VOBIZ_AUTH_TOKEN: "token-eorazvlmqwunmhwviocn" }, /production Supabase project/],
    [{ RAZORPAY_KEY_ID: "rzp_test_placeholder" }, /must stay unset/],
    [{ VOBIZ_REQUIRE_SIGNATURE: "false" }, /signature checks stay on/],
  ]) {
    const label = Object.keys(overrides).join(", ");
    const r = runWith(voiceOnly(overrides), ["check"]);
    assert.equal(r.status, 2, `${label}: ${r.out}`);
    assert.match(r.out, message, label);
    const deploy = runWith(voiceOnly(overrides), ["deploy", "--yes"]);
    assert.equal(deploy.status, 1, label);
    assert.match(deploy.out, /REFUSED/);
  }
  // The Worker name guard: any argument naming klyro is refused before anything runs.
  const klyro = runWith(voiceOnly(), ["deploy", "--yes", "--name", "klyro"]);
  assert.equal(klyro.status, 1);
  assert.match(klyro.out, /never the production Worker/);
});

test("the telephony webhook and calendar URLs must be the staging Worker's own host", () => {
  for (const [overrides, message] of [
    [
      { TELEPHONY_WEBHOOK_BASE_URL: "https://klyro.aiblaze-io.workers.dev" },
      /production Worker klyro/,
    ],
    [
      { GOOGLE_CALENDAR_REDIRECT_URI: "https://klyro.aiblaze-io.workers.dev/callback" },
      /GOOGLE_CALENDAR_REDIRECT_URI points at the production Worker klyro/,
    ],
    [
      { GOOGLE_CALENDAR_WEBHOOK_URL: "https://klyro.aiblaze-io.workers.dev/hook" },
      /GOOGLE_CALENDAR_WEBHOOK_URL points at the production Worker klyro/,
    ],
    [
      { TELEPHONY_WEBHOOK_BASE_URL: "https://app.clickai.example" },
      /isn't https:\/\/clickai-staging/,
    ],
    [
      { TELEPHONY_WEBHOOK_BASE_URL: "http://clickai-staging.example-sub.workers.dev" },
      /isn't https:\/\/clickai-staging/,
    ],
    [
      { TELEPHONY_WEBHOOK_BASE_URL: "https://clickai-staging.attacker.example" },
      /isn't https:\/\/clickai-staging/,
    ],
    [
      { TELEPHONY_WEBHOOK_BASE_URL: `${STAGING_WORKER_URL}/api` },
      /bare Worker origin, with no path/,
    ],
    [
      {
        GOOGLE_CALENDAR_REDIRECT_URI:
          "https://clickai-staging.other-account.workers.dev/api/public/integrations/google-calendar/callback",
      },
      /name different Workers/,
    ],
  ]) {
    assertRefused(overrides, message);
  }
});

test("payments, mock telephony, other providers and unsigned Vobiz webhooks are refused", () => {
  for (const [overrides, message] of [
    [{ RAZORPAY_KEY_ID: "rzp_test_placeholder" }, /RAZORPAY_KEY_ID must stay unset/],
    [{ RAZORPAY_CLIENT_SECRET: "placeholder" }, /RAZORPAY_CLIENT_SECRET must stay unset/],
    [{ ANTHROPIC_API_KEY: "rzp_live_placeholder" }, /holds a live Razorpay key/],
    [{ TELEPHONY_ALLOW_MOCK: "true" }, /TELEPHONY_ALLOW_MOCK must stay unset/],
    [{ EXOTEL_SID: "placeholder" }, /EXOTEL_SID must stay unset/],
    [{ VOBIZ_REQUIRE_SIGNATURE: "false" }, /VOBIZ_REQUIRE_SIGNATURE must be "true" or unset/],
  ]) {
    assertRefused(overrides, message);
  }
  // Signature checks explicitly on is fine.
  assert.equal(runWith(complete({ VOBIZ_REQUIRE_SIGNATURE: "true" }), ["check"]).status, 0);
});

test("malformed voice settings are NOT READY", () => {
  for (const [overrides, message] of [
    [{ VOBIZ_PHONE_NUMBER: "09876543210" }, /E\.164/],
    [{ MEDIA_SESSION_TOKEN_SECRET: "short" }, /shorter than 32/],
    [
      { GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY: "c2hvcnQ=" },
      /GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY isn't 32/,
    ],
    [{ VOICE_LLM_PROVIDER: "openai" }, /VOICE_LLM_PROVIDER must be/],
    [{ VOBIZ_BASE_URL: "http://api.vobiz.example" }, /VOBIZ_BASE_URL isn't an https URL/],
  ]) {
    assertRefused(overrides, message);
  }
});

test("production fingerprints: a staging key identical to production is refused, without printing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "staging-helper-fingerprints-"));
  const file = join(dir, "fingerprints.json");
  const sha = (v) => createHash("sha256").update(v).digest("hex");
  try {
    // The operator's production Sarvam key happens to equal the staging one.
    writeFileSync(file, JSON.stringify({ SARVAM_API_KEY: sha(`sarvam-${SECRET_MARKER}`) }));
    assertRefused({}, /SARVAM_API_KEY is identical to a production value/, {
      STAGING_PRODUCTION_FINGERPRINTS: file,
    });
    writeFileSync(file, JSON.stringify({ SARVAM_API_KEY: sha("a-different-production-key") }));
    const ok = runWith(complete(), ["check"], { STAGING_PRODUCTION_FINGERPRINTS: file });
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /compared against 1 production fingerprints/);
    const missing = runWith(complete(), ["check"], {
      STAGING_PRODUCTION_FINGERPRINTS: join(dir, "absent.json"),
    });
    assert.equal(missing.status, 1);
    assert.match(missing.out, /names a missing file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the production Supabase project is refused wherever it appears", () => {
  for (const overrides of [
    { SUPABASE_URL: "https://eorazvlmqwunmhwviocn.supabase.co" },
    { VITE_SUPABASE_URL: "https://eorazvlmqwunmhwviocn.supabase.co" },
    { SUPABASE_SERVICE_ROLE_KEY: "something-eorazvlmqwunmhwviocn" },
  ]) {
    const r = runWith(complete(overrides), ["check"]);
    assert.equal(r.status, 2, JSON.stringify(overrides));
    assert.match(r.out, /production Supabase project/);
    const deploy = runWith(complete(overrides), ["deploy", "--yes"]);
    assert.equal(deploy.status, 1);
    assert.match(deploy.out, /REFUSED/);
  }
});

test("server and browser pointing at different projects, or a non-hosted URL, are refused", () => {
  assert.match(
    runWith(complete({ VITE_SUPABASE_URL: "https://zyxwvutsrqponmlkjihg.supabase.co" }), ["check"])
      .out,
    /different projects/,
  );
  assert.match(
    runWith(complete({ SUPABASE_URL: "http://127.0.0.1:54321" }), ["check"]).out,
    /isn't a hosted/,
  );
});

test("missing values, malformed versions and a wrong-length key are NOT READY", () => {
  assert.equal(runWith(complete({ META_APP_SECRET: "" }), ["check"]).status, 2);
  assert.match(runWith(complete({ META_GRAPH_API_VERSION: "23" }), ["check"]).out, /vNN\.N/);
  assert.match(
    runWith(complete({ WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: "c2hvcnQ=" }), ["check"]).out,
    /32 base64/,
  );
});

test("changes need --yes, and the production Worker is never a target", () => {
  for (const action of ["secrets", "deploy"]) {
    const r = runWith(complete(), [action]);
    assert.equal(r.status, 1);
    assert.match(r.out, /re-run with --yes/);
  }
  const klyro = runWith(complete(), ["deploy", "--yes", "--name", "klyro"]);
  assert.equal(klyro.status, 1);
  assert.match(klyro.out, /never the production Worker/);
});

// --- verify-supabase (offline: format, project and key-type checks only) ---
const NEW_REF = "todgvosuqixrcbnnwpwv";
const fakeJwt = (claims) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const supabaseOnly = (overrides = {}) =>
  complete({
    SUPABASE_URL: `https://${NEW_REF}.supabase.co`,
    VITE_SUPABASE_URL: `https://${NEW_REF}.supabase.co`,
    SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${SECRET_MARKER}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${SECRET_MARKER}`,
    SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${SECRET_MARKER}`,
    ...overrides,
  });
const verifyArgs = ["verify-supabase", "--ref", NEW_REF, "--offline"];

test("verify-supabase: the expected project passes, production is named as rejected, no value is printed", () => {
  const r = runWith(supabaseOnly(), verifyArgs);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /VERIFIED/);
  assert.match(r.out, new RegExp(`expected staging project: ${NEW_REF}`));
  assert.match(r.out, /production project eorazvlmqwunmhwviocn: rejected/);
  assert.doesNotMatch(r.out, new RegExp(SECRET_MARKER));
});

test("verify-supabase: legacy JWT keys are checked for role and project", () => {
  const ok = runWith(
    supabaseOnly({
      SUPABASE_PUBLISHABLE_KEY: fakeJwt({ role: "anon", ref: NEW_REF }),
      VITE_SUPABASE_PUBLISHABLE_KEY: fakeJwt({ role: "anon", ref: NEW_REF }),
      SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ role: "service_role", ref: NEW_REF }),
    }),
    verifyArgs,
  );
  assert.equal(ok.status, 0, ok.out);
  for (const [overrides, message] of [
    [
      {
        SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ role: "service_role", ref: "eorazvlmqwunmhwviocn" }),
      },
      /production/,
    ],
    [
      { SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ role: "service_role", ref: "zyxwvutsrqponmlkjihg" }) },
      /belongs to project zyxwvutsrqponmlkjihg/,
    ],
    [{ SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ role: "anon", ref: NEW_REF }) }, /isn't a secret key/],
  ]) {
    const r = runWith(supabaseOnly(overrides), verifyArgs);
    assert.equal(r.status, 2, JSON.stringify(overrides));
    assert.match(r.out, message);
  }
});

test("verify-supabase: production, another project, swapped keys and a production --ref are all refused", () => {
  for (const [overrides, message] of [
    [{ SUPABASE_URL: "https://eorazvlmqwunmhwviocn.supabase.co" }, /production/],
    [
      { VITE_SUPABASE_URL: "https://zyxwvutsrqponmlkjihg.supabase.co" },
      /names project zyxwvutsrqponmlkjihg/,
    ],
    [{ SUPABASE_URL: "http://127.0.0.1:54321" }, /isn't a hosted/],
    [{ SUPABASE_SERVICE_ROLE_KEY: `sb_publishable_${SECRET_MARKER}` }, /isn't a secret key/],
    [{ SUPABASE_PUBLISHABLE_KEY: `sb_secret_${SECRET_MARKER}` }, /isn't a publishable key/],
    [{ SUPABASE_SERVICE_ROLE_KEY: "" }, /is empty/],
  ]) {
    const r = runWith(supabaseOnly(overrides), verifyArgs);
    assert.equal(r.status, 2, JSON.stringify(overrides));
    assert.match(r.out, message);
    assert.doesNotMatch(r.out, new RegExp(SECRET_MARKER));
  }
  const prodRef = runWith(supabaseOnly(), [
    "verify-supabase",
    "--ref",
    "eorazvlmqwunmhwviocn",
    "--offline",
  ]);
  assert.equal(prodRef.status, 1);
  assert.match(prodRef.out, /production project/);
});

// --- migrate (offline: --check-only, so the Supabase CLI never runs) ---
const POOLER_PASSWORD = `pw-${SECRET_MARKER}`;
const pooler = (user, host = "aws-0-ap-south-1.pooler.supabase.com", port = "5432") =>
  `postgresql://${user}:${POOLER_PASSWORD}@${host}:${port}/postgres`;

function migrateWith(dbUrl, args) {
  const dir = mkdtempSync(join(tmpdir(), "staging-helper-migrate-"));
  const file = join(dir, ".env.staging.local");
  writeFileSync(
    file,
    Object.entries(supabaseOnly())
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  try {
    const r = spawnSync(process.execPath, [script, "migrate", ...args], {
      encoding: "utf8",
      env: { ...process.env, STAGING_ENV_FILE: file, STAGING_DB_URL: dbUrl },
      input: "",
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const checkOnly = ["--ref", NEW_REF, "--check-only", "--offline"];

test("migrate: the staging session pooler passes the target check; the password is never printed", () => {
  const r = migrateWith(pooler(`postgres.${NEW_REF}`), checkOnly);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`connection target: project ${NEW_REF} via session pooler`));
  assert.match(r.out, /CHECK ONLY: target verified; the Supabase CLI was not run/);
  assert.doesNotMatch(r.out, new RegExp(SECRET_MARKER));
});

test("migrate: production, another project, the transaction pooler and direct connections are refused", () => {
  for (const [url, message] of [
    [pooler("postgres.eorazvlmqwunmhwviocn"), /production project/],
    [pooler("postgres.zyxwvutsrqponmlkjihg"), /names project zyxwvutsrqponmlkjihg/],
    [pooler(`postgres.${NEW_REF}`, undefined, "6543"), /transaction pooler/],
    [
      `postgresql://postgres:${POOLER_PASSWORD}@db.${NEW_REF}.supabase.co:5432/postgres`,
      /isn't a Supabase pooler/,
    ],
    [pooler("postgres"), /user isn't postgres\.<project ref>/],
    [
      `postgresql://postgres.${NEW_REF}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
      /password is missing/,
    ],
    ["not a url", /isn't a valid URL/],
  ]) {
    const r = migrateWith(url, checkOnly);
    assert.equal(r.status, 1, `${message}: ${r.out}`);
    assert.match(r.out, message);
    assert.match(r.out, /nothing was run/);
    assert.doesNotMatch(r.out, new RegExp(SECRET_MARKER));
  }
});

test("migrate: a production --ref, a missing --ref, and a real push without the reviewed count are refused", () => {
  const url = pooler(`postgres.${NEW_REF}`);
  assert.match(
    migrateWith(url, ["--ref", "eorazvlmqwunmhwviocn", "--check-only"]).out,
    /production project/,
  );
  assert.match(migrateWith(url, ["--check-only"]).out, /needs --ref/);
  for (const args of [
    ["--ref", NEW_REF, "--yes", "--offline"],
    ["--ref", NEW_REF, "--yes", "--expect", "3", "--offline"],
  ]) {
    const r = migrateWith(url, args);
    assert.equal(r.status, 1);
    assert.match(r.out, /a real push needs --expect \d+/);
  }
});
