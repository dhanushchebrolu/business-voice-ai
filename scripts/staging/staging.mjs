#!/usr/bin/env node
/**
 * ClickAI staging (WhatsApp sandbox and multilingual voice): guarded helper
 * for the clickai-staging Worker.
 *
 *   node scripts/staging/staging.mjs check            read-only; the default
 *   node scripts/staging/staging.mjs configure-supabase --ref <ref>
 *       prompts in the terminal for the staging project URL (shown) and its
 *       publishable and secret keys (hidden), validates them against <ref>,
 *       and saves them only to .env.staging.local
 *   node scripts/staging/staging.mjs verify-supabase --ref <ref> [--offline]
 *       confirms the saved URL and keys belong to <ref> (DNS, then read-only
 *       requests to that project); --offline skips the network checks
 *   node scripts/staging/staging.mjs migrate --ref <ref> [--check-only]
 *       verifies the project (as verify-supabase), takes the database's
 *       Session pooler connection string from STAGING_DB_URL or a hidden
 *       prompt (never printed, never written to disk), refuses anything but
 *       <ref>'s session pooler, then runs the pinned Supabase CLI's
 *       `db push --dry-run` and checks it lists exactly the local migrations,
 *       in order. --check-only stops before the CLI runs.
 *   node scripts/staging/staging.mjs migrate --ref <ref> --yes --expect <n>
 *       the same checks and dry run, then the real push and `migration list`.
 *   node scripts/staging/staging.mjs deploy --yes
 *       staging build, then `wrangler deploy --name clickai-staging
 *       --secrets-file <temp>`: the first deploy of a new Worker carries its
 *       server secrets (deploy-lib.mjs); the temp file is always removed
 *   node scripts/staging/staging.mjs secrets --yes
 *       `wrangler secret bulk`, for a Worker that already exists
 *
 * Reads the gitignored .env.staging.local. Never prints a value: only
 * variable names, the Supabase project reference (not a secret) and pass /
 * fail lines. Refuses to act when:
 *   - the target isn't exactly "clickai-staging" (never "klyro");
 *   - any value mentions the production Supabase project;
 *   - the server and browser Supabase URLs name different projects;
 *   - a required name is empty (WhatsApp, voice, telephony and calendar);
 *   - the telephony webhook base or a calendar URL isn't the staging
 *     Worker's own https://clickai-staging.<subdomain>.workers.dev host, or
 *     any URL setting points at klyro;
 *   - a payment (Razorpay, live or test), mock-telephony or other-provider
 *     setting is present, or Vobiz signature checks are switched off;
 *   - a value matches a production fingerprint (when one is supplied);
 *   - the staging build didn't generate a config named clickai-staging, or
 *     the generated config carries routes or the production project.
 * Nothing runs against Cloudflare without --yes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deployStaging, serverSecrets } from "./deploy-lib.mjs";

const WORKER = "clickai-staging";
const PRODUCTION_WORKER = "klyro";
const PRODUCTION_SUPABASE_REF = "eorazvlmqwunmhwviocn";
const repo = resolve(import.meta.dirname, "..", "..");
// STAGING_ENV_FILE exists for the helper's own tests (staging.test.mjs).
const envFile = process.env.STAGING_ENV_FILE ?? join(repo, ".env.staging.local");

/** Server-side Worker secrets (set with `wrangler secret bulk`). */
const SERVER_REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_WHATSAPP_CONFIG_ID",
  "META_GRAPH_API_VERSION",
  "WHATSAPP_CREDENTIAL_ENCRYPTION_KEY",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "LOVABLE_CRON_SECRET",
];
/**
 * The voice agent's server settings: speech (Sarvam), telephony (Vobiz),
 * media-stream tokens and the booking calendar. Required, so a staging
 * Worker never goes out half-configured for calls.
 */
const VOICE_REQUIRED = [
  "SARVAM_API_KEY",
  "TELEPHONY_WEBHOOK_BASE_URL",
  "MEDIA_SESSION_TOKEN_SECRET",
  "VOBIZ_AUTH_ID",
  "VOBIZ_AUTH_TOKEN",
  "VOBIZ_PHONE_NUMBER",
  "VOBIZ_WEBHOOK_VERIFY_TOKEN",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
  "GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY",
];
const SERVER_OPTIONAL = [
  "ANTHROPIC_API_KEY",
  "VOICE_LLM_PROVIDER",
  "SARVAM_ORG_ID",
  "SARVAM_WORKSPACE_ID",
  "SARVAM_CONTEXT_SECRET",
  "SARVAM_WEBHOOK_SECRET",
  "VOBIZ_BASE_URL",
  "VOBIZ_REQUIRE_SIGNATURE",
  "GOOGLE_CALENDAR_WEBHOOK_URL",
];
/**
 * Settings that must stay unset on staging: payments stay off (no Razorpay
 * at all, test keys included, until separately approved), the mock
 * telephony adapter stays unreachable, and only Vobiz carries calls.
 */
const PROHIBITED_PREFIXES = ["RAZORPAY_", "EXOTEL_", "TWILIO_"];
const PROHIBITED_NAMES = ["TELEPHONY_ALLOW_MOCK"];
/** URL settings that must point at the staging Worker's own host. */
const STAGING_HOST_URLS = [
  "TELEPHONY_WEBHOOK_BASE_URL",
  "GOOGLE_CALENDAR_REDIRECT_URI",
  "GOOGLE_CALENDAR_WEBHOOK_URL",
];
// Optional path to a JSON file of {NAME: sha256 hex of the production value},
// exported by an operator so `check` can prove staging keys aren't
// production's. Hashes only, never values.
const fingerprintFile = process.env.STAGING_PRODUCTION_FINGERPRINTS;
/** Public values baked into the browser bundle at build time. */
const BUILD_REQUIRED = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_META_APP_ID",
  "VITE_META_WHATSAPP_CONFIG_ID",
  "VITE_META_GRAPH_API_VERSION",
];

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

function loadEnv() {
  if (!existsSync(envFile)) fail(".env.staging.local is missing");
  const env = {};
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

/** The Supabase project reference a URL names, or null. */
function supabaseRef(url) {
  try {
    const host = new URL(url).host;
    const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(host);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** True when `url` is https on exactly clickai-staging.<subdomain>.workers.dev. */
function isStagingWorkerUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" && /^clickai-staging\.[a-z0-9-]+\.workers\.dev$/.test(u.hostname)
    );
  } catch {
    return false;
  }
}

/** sha256 hex digests of production values; null when no file was supplied. */
function productionFingerprints() {
  if (!fingerprintFile) return null;
  if (!existsSync(fingerprintFile)) fail("STAGING_PRODUCTION_FINGERPRINTS names a missing file");
  try {
    const parsed = JSON.parse(readFileSync(fingerprintFile, "utf8"));
    return Object.values(parsed).filter((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v));
  } catch {
    fail("STAGING_PRODUCTION_FINGERPRINTS isn't a JSON object of sha256 hex digests");
  }
}

/**
 * The voice, payment and production-isolation guards (never quotes a value).
 * `notes` are the honest limits of what a local check can prove.
 */
function stagingProblems(env) {
  const problems = [];
  const notes = [];
  for (const name of Object.keys(env).filter((n) => env[n])) {
    if (PROHIBITED_NAMES.includes(name) || PROHIBITED_PREFIXES.some((p) => name.startsWith(p))) {
      problems.push(
        `${name} must stay unset on staging (payments and mock/other telephony are off)`,
      );
    }
    if (env[name].includes("rzp_live_")) problems.push(`${name} holds a live Razorpay key`);
    if (/_UR[LI]$/.test(name) && /(^|[/.])klyro\./.test(env[name])) {
      problems.push(`${name} points at the production Worker klyro`);
    }
  }
  for (const name of STAGING_HOST_URLS) {
    if (env[name] && !isStagingWorkerUrl(env[name])) {
      problems.push(`${name} isn't https://clickai-staging.<subdomain>.workers.dev`);
    }
  }
  const hostOf = (n) => (isStagingWorkerUrl(env[n]) ? new URL(env[n]).host : null);
  const base = hostOf("TELEPHONY_WEBHOOK_BASE_URL");
  if (base && !/^\/?$/.test(new URL(env.TELEPHONY_WEBHOOK_BASE_URL).pathname)) {
    problems.push("TELEPHONY_WEBHOOK_BASE_URL must be the bare Worker origin, with no path");
  }
  for (const name of ["GOOGLE_CALENDAR_REDIRECT_URI", "GOOGLE_CALENDAR_WEBHOOK_URL"]) {
    const host = hostOf(name);
    if (base && host && host !== base) {
      problems.push(`${name} and TELEPHONY_WEBHOOK_BASE_URL name different Workers`);
    }
  }
  if (env.VOBIZ_REQUIRE_SIGNATURE && env.VOBIZ_REQUIRE_SIGNATURE !== "true") {
    problems.push('VOBIZ_REQUIRE_SIGNATURE must be "true" or unset (signature checks stay on)');
  }
  if (env.VOBIZ_BASE_URL && !/^https:\/\//.test(env.VOBIZ_BASE_URL)) {
    problems.push("VOBIZ_BASE_URL isn't an https URL");
  }
  if (env.VOBIZ_PHONE_NUMBER && !/^\+\d{8,15}$/.test(env.VOBIZ_PHONE_NUMBER)) {
    problems.push("VOBIZ_PHONE_NUMBER isn't an E.164 number (+<digits>)");
  }
  if (env.VOICE_LLM_PROVIDER && !["sarvam", "claude"].includes(env.VOICE_LLM_PROVIDER)) {
    problems.push('VOICE_LLM_PROVIDER must be "sarvam" or "claude"');
  }
  if (env.MEDIA_SESSION_TOKEN_SECRET && env.MEDIA_SESSION_TOKEN_SECRET.length < 32) {
    problems.push("MEDIA_SESSION_TOKEN_SECRET is shorter than 32 characters");
  }
  if (
    env.GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY &&
    Buffer.from(env.GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY, "base64").length !== 32
  ) {
    problems.push("GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY isn't 32 base64-encoded bytes");
  }
  // Staging keys must not be production's. That is only provable against
  // hashes of the production values; without them it stays an open item.
  const fingerprints = productionFingerprints();
  if (fingerprints === null) {
    notes.push("no production fingerprints: can't prove staging keys differ from production");
  } else {
    const production = new Set(fingerprints);
    for (const name of [...SERVER_REQUIRED, ...VOICE_REQUIRED, ...SERVER_OPTIONAL]) {
      if (!env[name] || ["VOBIZ_REQUIRE_SIGNATURE", "VOICE_LLM_PROVIDER"].includes(name)) continue;
      const digest = createHash("sha256").update(env[name]).digest("hex");
      if (production.has(digest)) problems.push(`${name} is identical to a production value`);
    }
    notes.push(`compared against ${production.size} production fingerprints`);
  }
  return { problems, notes };
}

function verify(env) {
  const problems = [];
  const missing = [...SERVER_REQUIRED, ...VOICE_REQUIRED, ...BUILD_REQUIRED].filter((n) => !env[n]);
  for (const [name, value] of Object.entries(env)) {
    if (value.includes(PRODUCTION_SUPABASE_REF)) {
      problems.push(`${name} mentions the production Supabase project`);
    }
  }
  const serverRef = env.SUPABASE_URL ? supabaseRef(env.SUPABASE_URL) : null;
  const browserRef = env.VITE_SUPABASE_URL ? supabaseRef(env.VITE_SUPABASE_URL) : null;
  if (env.SUPABASE_URL && !serverRef)
    problems.push("SUPABASE_URL isn't a hosted <ref>.supabase.co URL");
  if (env.VITE_SUPABASE_URL && !browserRef) {
    problems.push("VITE_SUPABASE_URL isn't a hosted <ref>.supabase.co URL");
  }
  if (serverRef && browserRef && serverRef !== browserRef) {
    problems.push("SUPABASE_URL and VITE_SUPABASE_URL name different projects");
  }
  if (serverRef === PRODUCTION_SUPABASE_REF || browserRef === PRODUCTION_SUPABASE_REF) {
    problems.push("the Supabase URL is the production project");
  }
  for (const n of ["META_GRAPH_API_VERSION", "VITE_META_GRAPH_API_VERSION"]) {
    if (env[n] && !/^v\d+\.\d+$/.test(env[n])) problems.push(`${n} isn't in the form vNN.N`);
  }
  if (
    env.META_GRAPH_API_VERSION &&
    env.VITE_META_GRAPH_API_VERSION &&
    env.META_GRAPH_API_VERSION !== env.VITE_META_GRAPH_API_VERSION
  ) {
    problems.push("META_GRAPH_API_VERSION and VITE_META_GRAPH_API_VERSION differ");
  }
  if (env.META_APP_ID && env.VITE_META_APP_ID && env.META_APP_ID !== env.VITE_META_APP_ID) {
    problems.push("META_APP_ID and VITE_META_APP_ID differ");
  }
  if (
    env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY &&
    Buffer.from(env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY, "base64").length !== 32
  ) {
    problems.push("WHATSAPP_CREDENTIAL_ENCRYPTION_KEY isn't 32 base64-encoded bytes");
  }
  const staging = stagingProblems(env);
  problems.push(...staging.problems);
  return { missing, problems, notes: staging.notes, ref: serverRef ?? browserRef };
}

function report(env) {
  const { missing, problems, notes, ref } = verify(env);
  console.log(`target Worker: ${WORKER}`);
  console.log(`staging Supabase project ref: ${ref ?? "(not set)"}`);
  for (const n of [...SERVER_REQUIRED, ...VOICE_REQUIRED, ...BUILD_REQUIRED, ...SERVER_OPTIONAL]) {
    const opt = SERVER_OPTIONAL.includes(n) ? " (optional)" : "";
    console.log(`  ${env[n] ? "present" : "MISSING"}  ${n}${opt}`);
  }
  for (const p of problems) console.log(`  PROBLEM  ${p}`);
  for (const n of notes) console.log(`  NOTE  ${n}`);
  return { ready: missing.length === 0 && problems.length === 0, problems };
}

/** Claims of a legacy JWT API key (not secret on their own: project ref and role). */
function jwtClaims(key) {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** "publishable" | "secret" | "unknown", plus the project ref when the key names one. */
function keyKind(key) {
  if (key.startsWith("sb_publishable_")) return { kind: "publishable", ref: null };
  if (key.startsWith("sb_secret_")) return { kind: "secret", ref: null };
  const claims = jwtClaims(key);
  if (!claims) return { kind: "unknown", ref: null };
  const kind =
    claims.role === "anon" ? "publishable" : claims.role === "service_role" ? "secret" : "unknown";
  return { kind, ref: typeof claims.ref === "string" ? claims.ref : null };
}

/** Problems with the Supabase values for project `expectedRef` (never quotes a value). */
function supabaseProblems(values, expectedRef) {
  const problems = [];
  if (!/^[a-z0-9]{20}$/.test(expectedRef ?? ""))
    problems.push("--ref must be a 20-character project ref");
  if (expectedRef === PRODUCTION_SUPABASE_REF) problems.push("--ref is the production project");
  for (const name of ["SUPABASE_URL", "VITE_SUPABASE_URL"]) {
    const ref = supabaseRef(values[name] ?? "");
    if (!ref) problems.push(`${name} isn't a hosted https://<ref>.supabase.co URL`);
    else if (ref === PRODUCTION_SUPABASE_REF) problems.push(`${name} is the production project`);
    else if (ref !== expectedRef) problems.push(`${name} names project ${ref}, not ${expectedRef}`);
  }
  const expectations = [
    ["SUPABASE_PUBLISHABLE_KEY", "publishable"],
    ["VITE_SUPABASE_PUBLISHABLE_KEY", "publishable"],
    ["SUPABASE_SERVICE_ROLE_KEY", "secret"],
  ];
  for (const [name, want] of expectations) {
    const value = values[name] ?? "";
    if (!value) {
      problems.push(`${name} is empty`);
      continue;
    }
    if (/\s/.test(value)) problems.push(`${name} contains whitespace`);
    if (value.includes(PRODUCTION_SUPABASE_REF))
      problems.push(`${name} mentions the production project`);
    const { kind, ref } = keyKind(value);
    if (kind !== want) problems.push(`${name} isn't a ${want} key (looks ${kind})`);
    if (ref === PRODUCTION_SUPABASE_REF) problems.push(`${name} belongs to the production project`);
    else if (ref && ref !== expectedRef) problems.push(`${name} belongs to project ${ref}`);
  }
  if (values.SUPABASE_PUBLISHABLE_KEY !== values.VITE_SUPABASE_PUBLISHABLE_KEY) {
    problems.push("SUPABASE_PUBLISHABLE_KEY and VITE_SUPABASE_PUBLISHABLE_KEY differ");
  }
  return problems;
}

/** Replaces (or appends) NAME=value lines in the env file, keeping everything else. */
function saveValues(updates) {
  const lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m && pending.has(m[1])) {
      const value = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]}=${value}`;
    }
    return line;
  });
  for (const [name, value] of pending) out.push(`${name}=${value}`);
  writeFileSync(envFile, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

/** Reads one line from the terminal; `hidden` doesn't echo what's typed. */
function ask(question, { hidden = false } = {}) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      done(answer.trim());
    });
  });
}

/** Read-only network checks that the saved URL and keys belong to the project. */
async function verifyOnline(values, expectedRef) {
  const results = [];
  const url = values.SUPABASE_URL.replace(/\/+$/, "");
  const host = new URL(url).host;
  try {
    await lookup(host);
    results.push([true, `DNS: ${expectedRef}.supabase.co resolves`]);
  } catch {
    results.push([false, `DNS: ${expectedRef}.supabase.co does not resolve`]);
    return results;
  }
  const headersFor = (key) =>
    key.startsWith("sb_") ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
  const probe = async (label, path, key) => {
    try {
      const r = await fetch(`${url}${path}`, { headers: headersFor(key) });
      await r.body?.cancel();
      results.push([r.status === 200, `${label}: HTTP ${r.status}`]);
    } catch {
      results.push([false, `${label}: no response`]);
    }
  };
  await probe(
    "publishable key accepted by the project (auth settings)",
    "/auth/v1/settings",
    values.SUPABASE_PUBLISHABLE_KEY,
  );
  await probe(
    "secret key accepted by the project (REST root)",
    "/rest/v1/",
    values.SUPABASE_SERVICE_ROLE_KEY,
  );
  return results;
}

async function verifySupabase(values, expectedRef, offline) {
  const problems = supabaseProblems(values, expectedRef);
  console.log(`expected staging project: ${expectedRef}`);
  console.log(`production project ${PRODUCTION_SUPABASE_REF}: rejected`);
  for (const p of problems) console.log(`  FAIL  ${p}`);
  if (problems.length > 0) return false;
  console.log("  PASS  URLs name the expected project (server and browser)");
  console.log("  PASS  key types match (publishable / secret) and name no other project");
  if (offline) {
    console.log("  SKIP  network checks (--offline)");
    return true;
  }
  const online = await verifyOnline(values, expectedRef);
  for (const [ok, line] of online) console.log(`  ${ok ? "PASS" : "FAIL"}  ${line}`);
  return online.every(([ok]) => ok);
}

/** The Supabase CLI version every migration command uses (pinned, never "latest"). */
const SUPABASE_CLI = "supabase@2.120.0";

/**
 * Checks a Postgres connection string targets `expectedRef`'s SESSION pooler
 * (aws-*.pooler.supabase.com:5432, user postgres.<ref>). Returns the problems
 * (never quoting the string) and a printable target summary.
 */
function sessionPoolerProblems(dbUrl, expectedRef) {
  const problems = [];
  let u;
  try {
    u = new URL(dbUrl);
  } catch {
    return { problems: ["the connection string isn't a valid URL"], target: null };
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push("not a postgres:// connection string");
  if (decodeURIComponent(dbUrl).includes(PRODUCTION_SUPABASE_REF)) {
    problems.push("it mentions the production project");
  }
  const user = decodeURIComponent(u.username);
  const userRef = /^postgres\.([a-z0-9]{20})$/.exec(user)?.[1] ?? null;
  if (!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(u.hostname)) {
    problems.push("the host isn't a Supabase pooler (use the Session pooler string)");
  }
  if (u.port !== "5432") {
    problems.push(
      u.port === "6543"
        ? "port 6543 is the transaction pooler; use the Session pooler (5432)"
        : "the port isn't the session pooler's 5432",
    );
  }
  if (!userRef) problems.push("the user isn't postgres.<project ref>");
  else if (userRef === PRODUCTION_SUPABASE_REF)
    problems.push("the user names the production project");
  else if (userRef !== expectedRef)
    problems.push(`the user names project ${userRef}, not ${expectedRef}`);
  if (!u.password) problems.push("the password is missing");
  const target = userRef
    ? `project ${userRef} via session pooler ${u.hostname}:${u.port}, database ${u.pathname.slice(1) || "postgres"}`
    : null;
  return { problems, target };
}

/** The local migrations, in the order `supabase db push` applies them. */
function localMigrations() {
  const dir = join(repo, "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f))
    .sort();
}

/** Runs the pinned Supabase CLI without a shell; returns its exit code and redacted output. */
function supabaseCli(args, secretsToRedact) {
  const npxCli = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ].find((p) => existsSync(p));
  if (!npxCli) fail("couldn't find npm's npx next to this Node.js");
  const r = spawnSync(process.execPath, [npxCli, "--yes", SUPABASE_CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60_000,
  });
  let out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  for (const secret of secretsToRedact.filter(Boolean)) {
    out = out.split(secret).join("<redacted>");
  }
  out = out.replace(/postgres(ql)?:\/\/[^\s"']+/g, "<redacted connection string>");
  return { status: r.status ?? 1, out };
}

/** Compares the migrations a dry run lists against the local ones (version and file name, in order). */
function compareDryRun(out, local) {
  const listed = [...out.matchAll(/(\d{14}_[^\s/\\]+?\.sql)/g)].map((m) => m[1]);
  const seen = [...new Set(listed)];
  const missing = local.filter((f) => !seen.includes(f));
  const unexpected = seen.filter((f) => !local.includes(f));
  const inOrder =
    JSON.stringify(seen.filter((f) => local.includes(f))) ===
    JSON.stringify(local.filter((f) => seen.includes(f)));
  return { seen, missing, unexpected, inOrder };
}

async function migrate(flags, ref) {
  if (!ref) fail("migrate needs --ref <staging project ref>");
  if (ref === PRODUCTION_SUPABASE_REF) fail("--ref is the production project");
  const push = flags.includes("--yes");
  const checkOnly = flags.includes("--check-only");
  const expectIdx = flags.indexOf("--expect");
  const expected = expectIdx >= 0 ? Number(flags[expectIdx + 1]) : null;

  const local = localMigrations();
  console.log(`local migrations: ${local.length} (${local[0]} … ${local.at(-1)})`);
  if (push && expected !== local.length) {
    fail(
      `a real push needs --expect ${local.length} (the number of local migrations you reviewed)`,
    );
  }

  // 1. The staging project, verified independently through its own API.
  if (!existsSync(envFile)) fail(".env.staging.local is missing");
  const verified = await verifySupabase(loadEnv(), ref, flags.includes("--offline"));
  if (!verified) fail("the staging project couldn't be verified; nothing was run");

  // 2. The database connection: session pooler for exactly this project.
  const dbUrl =
    process.env.STAGING_DB_URL ||
    (await ask(`Session pooler connection string for ${ref} (hidden): `, { hidden: true }));
  const { problems, target } = sessionPoolerProblems(dbUrl, ref);
  for (const p of problems) console.log(`  FAIL  ${p}`);
  if (problems.length > 0) fail("wrong or unverifiable target; nothing was run");
  console.log(`  PASS  connection target: ${target}`);
  if (checkOnly) {
    console.log("CHECK ONLY: target verified; the Supabase CLI was not run");
    process.exit(0);
  }
  const password = decodeURIComponent(new URL(dbUrl).password);
  const redact = [dbUrl, password, encodeURIComponent(password)];

  // 3. Dry run (always, also before a real push): exactly the local set, in order.
  console.log(`running: npx ${SUPABASE_CLI} db push --db-url <hidden> --dry-run`);
  const dry = supabaseCli(["db", "push", "--db-url", dbUrl, "--dry-run"], redact);
  const cmp = compareDryRun(dry.out, local);
  console.log(`dry run exit code: ${dry.status}; migrations it would apply: ${cmp.seen.length}`);
  for (const f of cmp.seen) console.log(`  ${f}`);
  const discrepancies = [
    ...(dry.status !== 0 ? [`the dry run exited with ${dry.status}`] : []),
    ...cmp.missing.map((f) => `not in the dry run: ${f}`),
    ...cmp.unexpected.map((f) => `unexpected in the dry run: ${f}`),
    ...(cmp.inOrder ? [] : ["the dry run's order differs from the local order"]),
    ...(cmp.seen.length !== local.length
      ? [`${cmp.seen.length} listed, ${local.length} expected`]
      : []),
  ];
  if (discrepancies.length > 0) {
    for (const d of discrepancies) console.log(`  FAIL  ${d}`);
    console.log("--- dry run output (redacted) ---");
    console.log(dry.out.trim());
    fail("the dry run doesn't match; nothing was applied");
  }
  console.log(`  PASS  the dry run lists exactly the ${local.length} local migrations, in order`);
  if (!push) {
    console.log("DRY RUN ONLY: nothing was applied");
    process.exit(0);
  }

  // 4. The real push (only with --yes --expect N), then the resulting history.
  console.log(`running: npx ${SUPABASE_CLI} db push --db-url <hidden> --yes`);
  const real = supabaseCli(["db", "push", "--db-url", dbUrl, "--yes"], redact);
  console.log(real.out.trim());
  if (real.status !== 0) fail(`db push exited with ${real.status}`);
  const list = supabaseCli(["migration", "list", "--db-url", dbUrl], redact);
  console.log(list.out.trim());
  process.exit(list.status === 0 ? 0 : 1);
}

/**
 * Runs `npx <args>` through npm's own npx-cli.js (no shell, so paths and
 * values are passed through unchanged) and returns the exit code. It never
 * exits the process, so callers' `finally` cleanup always runs.
 */
function runStatus(cmd, args, extraEnv = {}) {
  if (cmd !== "npx") throw new Error(`runStatus only runs npx, not ${cmd}`);
  const npxCli = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ].find((p) => existsSync(p));
  if (!npxCli) throw new Error("couldn't find npm's npx next to this Node.js");
  const r = spawnSync(process.execPath, [npxCli, ...args], {
    cwd: repo,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  return r.status ?? 1;
}

const [action = "check", ...flags] = process.argv.slice(2);
if (process.argv.some((a) => a.includes(PRODUCTION_WORKER))) fail("never the production Worker");
const refFlag = flags.indexOf("--ref");
const expectedRef = refFlag >= 0 ? flags[refFlag + 1] : undefined;

if (action === "configure-supabase" || action === "verify-supabase") {
  if (!expectedRef) fail(`${action} needs --ref <staging project ref>`);
  if (expectedRef === PRODUCTION_SUPABASE_REF) fail("--ref is the production project");
  if (!existsSync(envFile)) fail(".env.staging.local is missing");
  if (action === "configure-supabase") {
    console.log(
      `Configuring staging project ${expectedRef} (values are saved only to .env.staging.local).`,
    );
    const url = await ask(`Staging project URL (https://${expectedRef}.supabase.co): `);
    const publishable = await ask("Publishable key (hidden): ", { hidden: true });
    const secret = await ask("Secret / service-role key (hidden): ", { hidden: true });
    const values = {
      SUPABASE_URL: url.replace(/\/+$/, ""),
      VITE_SUPABASE_URL: url.replace(/\/+$/, ""),
      SUPABASE_PUBLISHABLE_KEY: publishable,
      VITE_SUPABASE_PUBLISHABLE_KEY: publishable,
      SUPABASE_SERVICE_ROLE_KEY: secret,
    };
    const problems = supabaseProblems(values, expectedRef);
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FAIL  ${p}`);
      fail("nothing was saved");
    }
    saveValues(values);
    console.log("saved to .env.staging.local (values not shown)");
  }
  const ok = await verifySupabase(loadEnv(), expectedRef, flags.includes("--offline"));
  console.log(ok ? "VERIFIED" : "NOT VERIFIED");
  process.exit(ok ? 0 : 2);
}

if (action === "migrate") {
  await migrate(flags, expectedRef);
}

const env = loadEnv();
const { ready, problems } = report(env);

if (action === "check") {
  console.log(ready ? "READY" : "NOT READY (fill in the MISSING names / fix the PROBLEMs)");
  process.exit(ready ? 0 : 2);
}
if (!flags.includes("--yes"))
  fail(`"${action}" changes Cloudflare; re-run with --yes once approved`);
if (!ready) fail(problems[0] ?? "required names are missing");

if (action === "secrets") {
  // For a Worker that already exists (the first deploy carries its own secrets).
  const secrets = serverSecrets(env, [...SERVER_REQUIRED, ...VOICE_REQUIRED], SERVER_OPTIONAL);
  const dir = mkdtempSync(join(tmpdir(), "clickai-staging-"));
  let status;
  try {
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    status = runStatus("npx", [
      "--no-install",
      "wrangler",
      "secret",
      "bulk",
      file,
      "--name",
      WORKER,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (status !== 0) fail(`wrangler secret bulk exited with ${status}`);
  console.log(`set ${Object.keys(secrets).length} secrets on ${WORKER} (values not shown)`);
} else if (action === "deploy") {
  try {
    deployStaging({
      env,
      required: [...SERVER_REQUIRED, ...VOICE_REQUIRED],
      optional: SERVER_OPTIONAL,
      buildEnv: Object.fromEntries(BUILD_REQUIRED.map((n) => [n, env[n]])),
      run: runStatus,
      readGeneratedConfig: () =>
        JSON.parse(readFileSync(join(repo, ".output/server/wrangler.json"), "utf8")),
      tmpRoot: tmpdir(),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
} else {
  fail(
    `unknown action "${action}" (check | configure-supabase | verify-supabase | migrate | secrets | deploy)`,
  );
}
