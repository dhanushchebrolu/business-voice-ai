import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  bootstrapCluster,
  makeExecSql,
  registerSignalCleanup,
  teardownCluster,
  type Cluster,
  type RunResult,
} from "./pg-test-cluster.ts";
import {
  processDueNotifications,
  enqueueDueReminders,
} from "../../src/lib/whatsapp/whatsapp-notifications.server.ts";
import {
  launchCampaign,
  dispatchWhatsAppCampaigns,
  campaignAnalytics,
} from "../../src/lib/whatsapp/whatsapp-campaigns.server.ts";

/**
 * 20261020090000_whatsapp_notifications_and_campaigns.sql on a real
 * PostgreSQL with every migration applied, stood in the way production
 * behaves (NO default privileges):
 *   - the outbox triggers on bookings (including the create_booking_atomic
 *     RPC the voice agent uses), payment_requests and payment_domain_events:
 *     one row per logical notification, only for businesses that turned
 *     notifications on;
 *   - the idempotency unique index on whatsapp_messages;
 *   - the campaign tenant trigger, one open proposal per conversation;
 *   - RLS and grants: browsers read their own organization only and write
 *     nothing; the consent ledger is append-only even for the server.
 * With POSTGREST_BIN set, the notification worker, the reminder RPC and a
 * campaign also run through supabase-js against a real PostgREST (fake
 * Meta; nothing leaves the machine).
 */

const POSTGREST_BIN = process.env["POSTGREST_BIN"] ?? "";
const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

const STANDIN_NO_DEFAULT_PRIVILEGES = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated' $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
`;

const JWT_SECRET = `local-test-only-${randomUUID()}-${randomUUID()}`;
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const OWNER = randomUUID();
const OTHER_USER = randomUUID();
const BIZ = randomUUID();
const QUIET_BIZ = randomUUID(); // notifications off
const OTHER_BIZ = randomUUID();
const CONN = randomUUID();
const QUIET_CONN = randomUUID();
const OTHER_CONN = randomUUID();
const RZP = randomUUID();
const TEMPLATE = randomUUID();
const OTHER_TEMPLATE = randomUUID();

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;
let postgrest: ChildProcess | null = null;
let proxy: Server | null = null;
let postgrestSkip: string | null = null;
let postgrestFailure: string | null = null;
let postgrestLog = "";
let client: never;
const savedEnv = { ...process.env };

function sql(statement: string): RunResult {
  return execSql!(statement);
}
function rows(statement: string): string[] {
  const r = sql(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}
const asUser = (role: string, user: string, statement: string) =>
  sql(
    `SET ROLE ${role};\nSELECT set_config('request.jwt.claim.sub', '${user}', false);\n${statement}\nRESET ROLE;`,
  );

function serviceRoleJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role" })}`;
  return `${body}.${createHmac("sha256", JWT_SECRET).update(body).digest("base64url")}`;
}

before(async () => {
  const boot = bootstrapCluster();
  if (!boot.ok) {
    skipReason = boot.reason;
    return;
  }
  cluster = boot.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);
  const standin = sql(STANDIN_NO_DEFAULT_PRIVILEGES);
  if (standin.status !== 0) {
    setupFailure = `stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATIONS) {
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  process.env["VOBIZ_AUTH_ID"] = "MA_TEST";
  process.env["VOBIZ_AUTH_TOKEN"] = "vobiz-test-token";

  const seed = sql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${ORG}', 'Smile Dental', '${OWNER}'), ('${OTHER_ORG}', 'Other Clinic', '${OTHER_USER}');
    INSERT INTO public.organization_members (organization_id, user_id) VALUES
      ('${ORG}', '${OWNER}'), ('${OTHER_ORG}', '${OTHER_USER}');
    INSERT INTO public.businesses (id, organization_id, name, timezone, country) VALUES
      ('${BIZ}', '${ORG}', 'Smile Dental', 'Asia/Kolkata', 'IN'),
      ('${QUIET_BIZ}', '${ORG}', 'Smile Annex', 'Asia/Kolkata', 'IN'),
      ('${OTHER_BIZ}', '${OTHER_ORG}', 'Other Clinic', 'Asia/Kolkata', 'IN');
    INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
      SELECT o, b, d, false, '[{"start":"00:00","end":"23:59"}]'::jsonb
      FROM (VALUES ('${ORG}'::uuid, '${BIZ}'::uuid), ('${ORG}'::uuid, '${QUIET_BIZ}'::uuid)) t(o, b),
           generate_series(0, 6) d;
    INSERT INTO public.whatsapp_connections
      (id, organization_id, business_id, waba_id, phone_number_id, status, provider, vobiz_channel_id,
       notifications_enabled, transactional_consent_basis)
    VALUES
      ('${CONN}', '${ORG}', '${BIZ}', 'waba-1', 'pn-${CONN}', 'connected', 'vobiz', 'ch-1', true,
       'Customers agree to WhatsApp updates when booking'),
      ('${QUIET_CONN}', '${ORG}', '${QUIET_BIZ}', 'waba-2', 'pn-${QUIET_CONN}', 'connected', 'vobiz', 'ch-2', false, NULL),
      ('${OTHER_CONN}', '${OTHER_ORG}', '${OTHER_BIZ}', 'waba-3', 'pn-${OTHER_CONN}', 'connected', 'vobiz', 'ch-3', true, 'x');
    INSERT INTO public.razorpay_connections (id, organization_id, business_id, connection_status)
      VALUES ('${RZP}', '${ORG}', '${BIZ}', 'CONNECTED');
    INSERT INTO public.whatsapp_templates
      (id, organization_id, whatsapp_connection_id, name, language, category, status, body_text, body_param_count, purpose)
    VALUES
      ('${TEMPLATE}', '${ORG}', '${CONN}', 'diwali_offer', 'en', 'MARKETING', 'APPROVED', 'Hi {{1}}, {{2}} offer', 2, NULL),
      (gen_random_uuid(), '${ORG}', '${CONN}', 'booking_ok', 'en', 'UTILITY', 'APPROVED', 'Hi {{1}} {{2}} {{3}}', 3, 'booking_confirmed'),
      (gen_random_uuid(), '${ORG}', '${CONN}', 'booking_remind', 'en', 'UTILITY', 'APPROVED', 'Hi {{1}} {{2}} {{3}}', 3, 'booking_reminder'),
      ('${OTHER_TEMPLATE}', '${OTHER_ORG}', '${OTHER_CONN}', 'theirs', 'en', 'MARKETING', 'APPROVED', 'x', 0, NULL);
  `);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }

  if (!POSTGREST_BIN || !existsSync(POSTGREST_BIN)) {
    postgrestSkip = "no PostgREST binary (set POSTGREST_BIN) — real-PostgREST checks not run";
    return;
  }
  const auth = sql(`CREATE ROLE authenticator LOGIN NOINHERIT;
    GRANT anon, authenticated, service_role TO authenticator;`);
  if (auth.status !== 0) {
    postgrestFailure = auth.stderr;
    return;
  }
  const pgrstSocket = join(cluster.workDir, "postgrest.sock");
  postgrest = spawn(POSTGREST_BIN, [], {
    env: {
      ...process.env,
      PGRST_DB_URI: `postgresql://authenticator@/postgres?host=${cluster.sockDir}`,
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: JWT_SECRET,
      PGRST_SERVER_UNIX_SOCKET: pgrstSocket,
      PGRST_LOG_LEVEL: "error",
    },
  });
  postgrest.stdout?.on("data", (d: Buffer) => (postgrestLog += d.toString()));
  postgrest.stderr?.on("data", (d: Buffer) => (postgrestLog += d.toString()));
  proxy = createServer((req, res) => {
    const upstream = request(
      {
        socketPath: pgrstSocket,
        path: (req.url ?? "/").replace(/^\/rest\/v1/, "") || "/",
        method: req.method,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((r) => proxy!.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(`${url}/rest/v1/`, {
        headers: { Authorization: `Bearer ${serviceRoleJwt()}` },
      });
      if (r.status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      postgrestFailure = `PostgREST did not become ready: ${postgrestLog}`;
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  client = createClient(url, serviceRoleJwt(), {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as never;
});

after(async () => {
  postgrest?.kill("SIGTERM");
  await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
  unregister?.();
  if (cluster) teardownCluster(cluster);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function pgTest(name: string, fn: (t: TestContext) => void | Promise<void>) {
  test(name, async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    if (setupFailure) {
      assert.fail(`PostgreSQL is available, but setup failed — a real failure: ${setupFailure}`);
    }
    await fn(t);
  });
}
function restTest(name: string, fn: (t: TestContext) => void | Promise<void>) {
  pgTest(name, async (t) => {
    if (postgrestSkip) {
      t.skip(postgrestSkip);
      return;
    }
    if (postgrestFailure) assert.fail(`real-PostgREST setup failed: ${postgrestFailure}`);
    await fn(t);
  });
}

let phoneSeq = 0;
const phone = () => `+9198${String(10_000_000 + ++phoneSeq).padStart(8, "0")}`;

// The seeded hours are 00:00–23:59 Asia/Kolkata, so a 30-minute slot must start by 23:29 IST.
// Slots are pinned to local wall-clock time, not "now + N hours", so they fit at any time of day.
const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const SLOT_MS = 30 * 60_000;
type Slot = { start: string; end: string };
const slotAt = (startMs: number): Slot => ({
  start: new Date(startMs).toISOString(),
  end: new Date(startMs + SLOT_MS).toISOString(),
});
const nextIstMidnight = (ms: number) =>
  (Math.floor((ms + IST_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - IST_OFFSET_MS;

/** A fresh slot: two days ahead at 10:00 IST + 45 min × k — unique, and outside the reminder window. */
const SLOT_ANCHOR_MS = nextIstMidnight(Date.now()) + DAY_MS + 10 * 3_600_000;
let slotSeq = 0;
const nextSlot = (): Slot => slotAt(SLOT_ANCHOR_MS + slotSeq++ * 45 * 60_000);

/** A slot ~23 hours out (inside the reminder window [now + 23h, now + 24h]) that fits the hours. */
function reminderSlot(): Slot {
  const start = Math.ceil((Date.now() + 23 * 3_600_000 + 5 * 60_000) / 60_000) * 60_000;
  const midnight = nextIstMidnight(start);
  // Too late to end by 23:59 IST: midnight is at most 31 minutes later, still in the window.
  return slotAt(midnight - start < 31 * 60_000 ? midnight : start);
}

/** The voice agent's booking path: create_booking_atomic, as service_role. */
function voiceBooking(
  biz = BIZ,
  { start, end }: Slot = nextSlot(),
  customerPhone = phone(),
): string {
  const [id] = rows(`SET ROLE service_role;
    SELECT id FROM public.create_booking_atomic(
      '${ORG}', '${biz}', NULL, NULL, NULL, NULL, '${start}', '${end}', 'Asia/Kolkata',
      'Asha Rao', '${customerPhone}', NULL, 'voice', 'voice:${randomUUID()}', 'CONFIRMED', NULL, NULL, NULL);
    RESET ROLE;`).filter((l) => /^[0-9a-f-]{36}$/.test(l));
  assert.ok(id, "booking created");
  return id!;
}
const outbox = (bookingId: string) =>
  rows(
    `SELECT kind FROM public.whatsapp_notifications WHERE booking_id = '${bookingId}' ORDER BY created_at, kind;`,
  );

describe("outbox triggers", () => {
  pgTest("a voice booking (create_booking_atomic) enqueues exactly one confirmation", () => {
    const id = voiceBooking();
    assert.deepEqual(outbox(id), ["booking_confirmed"]);
    assert.deepEqual(
      rows(`SELECT dedupe_key FROM public.whatsapp_notifications WHERE booking_id = '${id}';`),
      [`booking_confirmed:${id}`],
    );
  });

  pgTest("nothing is enqueued for a business that hasn't turned notifications on", () => {
    const id = voiceBooking(QUIET_BIZ);
    assert.deepEqual(outbox(id), []);
  });

  pgTest("reschedule → one row per new time; cancel → one row; repeats add nothing", () => {
    const id = voiceBooking();
    const { start: moved, end: movedEnd } = nextSlot();
    for (let i = 0; i < 2; i++) {
      assert.equal(
        sql(
          `UPDATE public.bookings SET start_at = '${moved}', end_at = '${movedEnd}', status = 'RESCHEDULED' WHERE id = '${id}';`,
        ).status,
        0,
      );
    }
    for (let i = 0; i < 2; i++) {
      assert.equal(
        sql(`UPDATE public.bookings SET status = 'CANCELLED' WHERE id = '${id}';`).status,
        0,
      );
    }
    assert.deepEqual(outbox(id).sort(), [
      "booking_cancelled",
      "booking_confirmed",
      "booking_rescheduled",
    ]);
  });

  pgTest(
    "a booking moved A → B → C → B gets a notification for every move, including back to B",
    () => {
      const id = voiceBooking();
      const [b, c] = [nextSlot(), nextSlot()];
      const move = (to: Slot) =>
        assert.equal(
          sql(
            `UPDATE public.bookings SET start_at = '${to.start}', end_at = '${to.end}', status = 'RESCHEDULED' WHERE id = '${id}';`,
          ).status,
          0,
        );
      move(b); // A → B
      move(c); // B → C
      move(b); // C → B
      move(b); // a repeat of the same move adds nothing
      const moves = rows(
        `SELECT (payload->>'start_at')::timestamptz::text || '|' || dedupe_key FROM public.whatsapp_notifications
       WHERE booking_id = '${id}' AND kind = 'booking_rescheduled' ORDER BY created_at, id;`,
      );
      assert.equal(moves.length, 3, moves.join("\n"));
      assert.equal(new Set(moves.map((m) => m.split("|")[1])).size, 3, "distinct dedupe keys");
      const startOf = (m: string) => new Date(m.split("|")[0]!).getTime();
      assert.equal(startOf(moves[2]!), startOf(moves[0]!), "the last move is back to B");
    },
  );

  pgTest(
    "a hold confirmed by payment isn't confirmed twice (the payment notification covers it)",
    () => {
      const { start, end } = nextSlot();
      const [id] =
        rows(`INSERT INTO public.bookings (organization_id, business_id, start_at, end_at, timezone, status, customer_phone, source)
      VALUES ('${ORG}', '${BIZ}', '${start}', '${end}', 'Asia/Kolkata', 'PENDING_PAYMENT', '${phone()}', 'whatsapp') RETURNING id;`).filter(
          (l) => /^[0-9a-f-]{36}$/.test(l),
        );
      assert.deepEqual(outbox(id!), []);
      sql(`UPDATE public.bookings SET status = 'CONFIRMED' WHERE id = '${id}';`);
      assert.deepEqual(outbox(id!), []);

      // Payment link and payment events: delayed recovery rows (the inline paths send first).
      const [pr] = rows(`INSERT INTO public.payment_requests
        (organization_id, business_id, booking_id, razorpay_connection_id, amount_minor_units, currency, status, payment_link_url, idempotency_key)
      VALUES ('${ORG}', '${BIZ}', '${id}', '${RZP}', 50000, 'INR', 'CREATED', 'https://rzp.io/i/x', 'pr:${id}') RETURNING id;`).filter(
        (l) => /^[0-9a-f-]{36}$/.test(l),
      );
      sql(`INSERT INTO public.payment_domain_events (event_type, organization_id, business_id, payment_request_id, booking_id)
      VALUES ('PAYMENT_CAPTURED', '${ORG}', '${BIZ}', '${pr}', '${id}');`);
      assert.deepEqual(outbox(id!).sort(), ["payment_captured", "payment_link"]);
      assert.deepEqual(
        rows(
          `SELECT bool_and(next_attempt_at > now() + interval '1 minute') FROM public.whatsapp_notifications WHERE booking_id = '${id}';`,
        ),
        ["t"],
      );
    },
  );

  pgTest("enqueue is idempotent per dedupe key, and not callable from browsers", () => {
    const call = `SELECT public.enqueue_whatsapp_notification('${ORG}', '${BIZ}', NULL, NULL, 'booking_reminder', 'k-${ORG}', '{}'::jsonb, interval '0');`;
    assert.equal(asUser("service_role", OWNER, call).status, 0);
    assert.equal(asUser("service_role", OWNER, call).status, 0);
    assert.deepEqual(
      rows(`SELECT count(*) FROM public.whatsapp_notifications WHERE dedupe_key = 'k-${ORG}';`),
      ["1"],
    );
    for (const role of ["anon", "authenticated"]) {
      const r = asUser(role, OWNER, call);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /permission denied for function/);
    }
  });
});

describe("constraints", () => {
  pgTest(
    "one live outbound message per idempotency key per number; a failed one doesn't block a retry",
    () => {
      const conv = randomUUID();
      sql(
        `INSERT INTO public.whatsapp_conversations (id, organization_id, whatsapp_connection_id, wa_id) VALUES ('${conv}', '${ORG}', '${CONN}', '919800000777');`,
      );
      const msg = (status: string) => `INSERT INTO public.whatsapp_messages
      (organization_id, whatsapp_connection_id, conversation_id, direction, status, metadata)
      VALUES ('${ORG}', '${CONN}', '${conv}', 'outbound', '${status}', '{"idempotency_key":"payment_link:pr-x"}');`;
      assert.equal(sql(msg("failed")).status, 0);
      assert.equal(sql(msg("queued")).status, 0);
      const dup = sql(msg("queued"));
      assert.notEqual(dup.status, 0);
      assert.match(dup.stderr, /idx_whatsapp_messages_idempotency_live/);
    },
  );

  pgTest("a campaign can't use another organization's template or number", () => {
    const r =
      sql(`INSERT INTO public.whatsapp_campaigns (organization_id, business_id, whatsapp_connection_id, template_id, name)
      VALUES ('${ORG}', '${BIZ}', '${CONN}', '${OTHER_TEMPLATE}', 'x');`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /WHATSAPP_CAMPAIGN_TENANT_MISMATCH/);
  });

  pgTest("one open proposal per conversation", () => {
    const conv = randomUUID();
    sql(
      `INSERT INTO public.whatsapp_conversations (id, organization_id, whatsapp_connection_id, wa_id) VALUES ('${conv}', '${ORG}', '${CONN}', '919800000778');`,
    );
    const p = `INSERT INTO public.whatsapp_pending_actions (organization_id, business_id, conversation_id, action, params, summary, expires_at)
      VALUES ('${ORG}', '${BIZ}', '${conv}', 'book', '{}', 's', now() + interval '15 minutes');`;
    assert.equal(sql(p).status, 0);
    assert.match(sql(p).stderr, /idx_whatsapp_pending_actions_one_open/);
  });

  pgTest("re-applying the migration is a no-op", () => {
    const file = MIGRATIONS.find((f) => f.startsWith("20261020090000_"))!;
    const again = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
  });
});

describe("RLS and grants", () => {
  const TABLES = [
    "whatsapp_notifications",
    "whatsapp_consent_events",
    "whatsapp_suppressions",
    "whatsapp_templates",
    "whatsapp_campaigns",
    "whatsapp_campaign_recipients",
    "whatsapp_pending_actions",
    "whatsapp_audit_log",
  ];

  pgTest("browsers can't write any of the new tables", () => {
    for (const table of TABLES) {
      for (const p of ["INSERT", "UPDATE", "DELETE"]) {
        assert.deepEqual(
          rows(`SELECT has_table_privilege('authenticated', 'public.${table}', '${p}');`),
          ["f"],
          `${table} ${p}`,
        );
      }
      assert.deepEqual(
        rows(`SELECT has_table_privilege('anon', 'public.${table}', 'SELECT');`),
        ["f"],
        table,
      );
    }
  });

  pgTest("a member reads only their own organization's rows", () => {
    sql(`INSERT INTO public.whatsapp_audit_log (organization_id, actor_type, action, subject_type) VALUES
      ('${ORG}', 'system', 'mine', 'x'), ('${OTHER_ORG}', 'system', 'theirs', 'x');`);
    const seen = asUser(
      "authenticated",
      OWNER,
      `\\pset format unaligned\n\\pset tuples_only on\nSELECT DISTINCT organization_id FROM public.whatsapp_audit_log;\nSELECT DISTINCT organization_id FROM public.whatsapp_templates;`,
    ).stdout;
    assert.ok(seen.includes(ORG));
    assert.ok(!seen.includes(OTHER_ORG));
  });

  pgTest("the consent ledger is append-only, even for the server", () => {
    assert.deepEqual(
      rows(
        `SELECT has_table_privilege('service_role', 'public.whatsapp_consent_events', 'INSERT');`,
      ),
      ["t"],
    );
    for (const p of ["UPDATE", "DELETE", "TRUNCATE"]) {
      assert.deepEqual(
        rows(
          `SELECT has_table_privilege('service_role', 'public.whatsapp_consent_events', '${p}');`,
        ),
        ["f"],
        p,
      );
    }
  });

  pgTest("browsers can read the notification settings but still not the token", () => {
    const ok = asUser(
      "authenticated",
      OWNER,
      "SELECT notifications_enabled, transactional_consent_basis FROM public.whatsapp_connections;",
    );
    assert.equal(ok.status, 0, ok.stderr);
    const denied = asUser(
      "authenticated",
      OWNER,
      "SELECT access_token_ciphertext FROM public.whatsapp_connections;",
    );
    assert.notEqual(denied.status, 0);
  });
});

// ---------------------------------------------------------------------------
// The real worker and campaign code through supabase-js → PostgREST.

function fakeMeta() {
  const sent: { to: string; template?: { name: string } }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        id: `vmsg.${randomUUID()}`,
        status: "pending",
        meta_message_id: `wamid.${randomUUID()}`,
      }),
      {
        status: 200,
      },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe("real PostgREST", () => {
  restTest("voice booking → outbox → the worker sends the mapped template once", async () => {
    const customer = phone();
    const id = voiceBooking(BIZ, nextSlot(), customer);
    const meta = fakeMeta();
    const deps = { fetchImpl: meta.fetchImpl, sleep: async () => {} };
    await processDueNotifications(client, deps);
    await processDueNotifications(client, deps);
    const mine = meta.sent.filter((m) => m.to === customer.slice(1));
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.template?.name, "booking_ok");
    assert.deepEqual(
      rows(
        `SELECT status || '|' || attempts FROM public.whatsapp_notifications WHERE booking_id = '${id}';`,
      ),
      ["sent|1"],
    );
  });

  restTest("reminders are enqueued through the RPC (interval parameter) and sent", async () => {
    const customer = phone();
    const id = voiceBooking(BIZ, reminderSlot(), customer);
    // Pretend it was booked yesterday, and that its confirmation went out then.
    sql(`UPDATE public.bookings SET created_at = now() - interval '1 day' WHERE id = '${id}';
         UPDATE public.whatsapp_notifications SET status = 'sent' WHERE booking_id = '${id}';`);
    assert.ok((await enqueueDueReminders(client, new Date())) >= 1);
    assert.ok(outbox(id).includes("booking_reminder"));
    const meta = fakeMeta();
    await processDueNotifications(client, { fetchImpl: meta.fetchImpl, sleep: async () => {} });
    const mine = meta.sent.filter((m) => m.to === customer.slice(1));
    assert.deepEqual(
      mine.map((m) => m.template?.name),
      ["booking_remind"],
    );
  });

  restTest("a campaign reaches only opted-in numbers, once each, with analytics", async () => {
    const campaign = randomUUID();
    sql(`
      INSERT INTO public.whatsapp_consent_events (organization_id, business_id, wa_id, scope, action, source, created_at) VALUES
        ('${ORG}', '${BIZ}', '919811100001', 'marketing', 'opt_in', 'customer_form', now() - interval '2 days'),
        ('${ORG}', '${BIZ}', '919811100002', 'marketing', 'opt_in', 'customer_form', now() - interval '2 days'),
        ('${ORG}', '${BIZ}', '919811100002', 'marketing', 'opt_out', 'customer_keyword', now() - interval '1 day'),
        ('${ORG}', '${BIZ}', '919811100003', 'transactional', 'opt_in', 'staff_attested', now() - interval '1 day');
      INSERT INTO public.whatsapp_campaigns (id, organization_id, business_id, whatsapp_connection_id, template_id, name, template_params)
        VALUES ('${campaign}', '${ORG}', '${BIZ}', '${CONN}', '${TEMPLATE}', 'Diwali',
                '[{"source":"contact_first_name","fallback":"there"},{"source":"business_name"}]');`);
    const launched = await launchCampaign(client, {
      organizationId: ORG,
      campaignId: campaign,
      actorUserId: OWNER,
    });
    assert.deepEqual(launched, { eligible: 1, skipped: 0, status: "running" });
    const meta = fakeMeta();
    const deps = { fetchImpl: meta.fetchImpl, sleep: async () => {} };
    await dispatchWhatsAppCampaigns(client, deps);
    await dispatchWhatsAppCampaigns(client, deps);
    const campaignSends = meta.sent.filter((m) => m.template?.name === "diwali_offer");
    assert.deepEqual(
      campaignSends.map((m) => m.to),
      ["919811100001"],
    );
    assert.deepEqual(
      rows(`SELECT status FROM public.whatsapp_campaigns WHERE id = '${campaign}';`),
      ["completed"],
    );
    const analytics = await campaignAnalytics(client, ORG, campaign);
    assert.equal(analytics.total, 1);
    assert.equal(analytics.sent, 1);
    assert.deepEqual(
      rows(`SELECT action FROM public.whatsapp_audit_log WHERE subject_id = '${campaign}';`),
      ["campaign.launch"],
    );
  });
});
