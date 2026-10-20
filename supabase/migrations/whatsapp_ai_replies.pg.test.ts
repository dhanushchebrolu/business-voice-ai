import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
import { processInboundWhatsAppWebhook } from "../../src/lib/whatsapp/whatsapp-inbound.server.ts";
import { sendWhatsAppConversationMessage } from "../../src/lib/whatsapp/whatsapp-outbound.server.ts";
import {
  replyToInboundWhatsAppMessage,
  recoverPendingWhatsAppReplies,
  STALE_CLAIM_MS,
} from "../../src/lib/whatsapp/whatsapp-ai-reply.server.ts";
import { encryptCredential } from "../../src/lib/whatsapp/whatsapp-token-crypto.server.ts";

/**
 * 20261019090000_whatsapp_ai_replies.sql on a real PostgreSQL with every
 * migration applied, stood in the way production behaves (NO default
 * privileges, so every table has only the grants its migrations give it):
 *   - the cross-organization agent trigger, for the server and for the
 *     dashboard's own UPDATE (agent_config_id) grant;
 *   - one reply row per inbound message (the AI-reply claim);
 *   - customers stay read-only on conversations/messages and see only their
 *     own organization's rows;
 *   - the server role has what the WhatsApp code needs.
 *
 * With POSTGREST_BIN set (a local test tool — never production), the actual
 * inbound / outbound / AI-reply modules also run through the real
 * @supabase/supabase-js client against a real PostgREST, proving the
 * queries (quoted-timestamp `or`, JSON-path filters, count-head, the 23505
 * claim conflict) behave as the unit tests' in-memory fake assumes. Meta
 * and the model are fakes; nothing leaves the machine.
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
const OTHER_BIZ = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const CONN = randomUUID();
const OTHER_CONN = randomUUID();
const PN = `pn-${randomUUID().slice(0, 8)}`;
const OTHER_PN = `pn-${randomUUID().slice(0, 8)}`;

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

  process.env["META_APP_ID"] = "test-app";
  process.env["META_APP_SECRET"] = "test-secret";
  process.env["META_WHATSAPP_CONFIG_ID"] = "test-config";
  process.env["META_GRAPH_API_VERSION"] = "v23.0";
  process.env["WHATSAPP_CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
  const ciphertext = encryptCredential("test-access-token");

  const seed = sql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${ORG}', 'Smile Dental', '${OWNER}'), ('${OTHER_ORG}', 'Other Clinic', '${OTHER_USER}');
    INSERT INTO public.organization_members (organization_id, user_id) VALUES
      ('${ORG}', '${OWNER}'), ('${OTHER_ORG}', '${OTHER_USER}');
    INSERT INTO public.businesses (id, organization_id, name, timezone) VALUES
      ('${BIZ}', '${ORG}', 'Smile Dental', 'Asia/Kolkata'),
      ('${OTHER_BIZ}', '${OTHER_ORG}', 'Other Clinic', 'Asia/Kolkata');
    INSERT INTO public.agent_configs (id, organization_id, business_id) VALUES
      ('${AGENT}', '${ORG}', '${BIZ}'), ('${OTHER_AGENT}', '${OTHER_ORG}', '${OTHER_BIZ}');
    INSERT INTO public.whatsapp_connections
      (id, organization_id, business_id, agent_config_id, waba_id, phone_number_id, status, access_token_ciphertext)
    VALUES
      ('${CONN}', '${ORG}', '${BIZ}', '${AGENT}', 'waba-1', '${PN}', 'connected', '${ciphertext}'),
      ('${OTHER_CONN}', '${OTHER_ORG}', '${OTHER_BIZ}', '${OTHER_AGENT}', 'waba-2', '${OTHER_PN}', 'connected', '${ciphertext}');
  `);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }

  // Optional second layer: real PostgREST in front of the same database.
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

function newConversation(org = ORG, conn = CONN, lastInboundSql = "now()"): string {
  const id = randomUUID();
  const r = sql(`INSERT INTO public.whatsapp_conversations
      (id, organization_id, whatsapp_connection_id, wa_id, last_inbound_at)
    VALUES ('${id}', '${org}', '${conn}', '91${Math.floor(Math.random() * 1e10)}', ${lastInboundSql});`);
  assert.equal(r.status, 0, r.stderr);
  return id;
}
function newInbound(conversation: string, content = "hello", org = ORG, conn = CONN): string {
  const id = randomUUID();
  const r = sql(`INSERT INTO public.whatsapp_messages
      (id, organization_id, whatsapp_connection_id, conversation_id, wa_message_id, direction, message_type, content, status, occurred_at)
    VALUES ('${id}', '${org}', '${conn}', '${conversation}', 'wamid.${id}', 'inbound', 'text', '${content}', 'received', now() - interval '2 minutes');`);
  assert.equal(r.status, 0, r.stderr);
  return id;
}
const insertReply = (conversation: string, inbound: string) => `
  INSERT INTO public.whatsapp_messages
    (organization_id, whatsapp_connection_id, conversation_id, direction, message_type, status, reply_to_message_id)
  VALUES ('${ORG}', '${CONN}', '${conversation}', 'outbound', 'text', 'queued', '${inbound}');`;

describe("migration: schema", () => {
  pgTest("adds the columns with safe defaults for existing rows", () => {
    const conv = newConversation(ORG, CONN, "NULL");
    assert.deepEqual(
      rows(
        `SELECT ai_enabled || '|' || coalesce(handoff_requested_at::text, 'null') FROM public.whatsapp_conversations WHERE id = '${conv}';`,
      ),
      ["true|null"],
    );
    const msg = newInbound(conv);
    assert.deepEqual(
      rows(
        `SELECT attempts || '|' || coalesce(reply_to_message_id::text, 'null') FROM public.whatsapp_messages WHERE id = '${msg}';`,
      ),
      ["0|null"],
    );
    // Consent lives in the whatsapp_consent_events ledger (20261020090000), not on contacts.
    assert.deepEqual(
      rows(
        `SELECT count(*) FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'whatsapp_opt_in_at';`,
      ),
      ["0"],
    );
  });

  pgTest("re-applying the migration is a no-op (idempotent)", () => {
    const file = MIGRATIONS.find((f) => f.startsWith("20261019090000_"))!;
    const again = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
  });
});

describe("migration: one reply per inbound message", () => {
  pgTest("a second reply row for the same inbound message is rejected (23505)", () => {
    const conv = newConversation();
    const inbound = newInbound(conv);
    assert.equal(asUser("service_role", OWNER, insertReply(conv, inbound)).status, 0);
    const dup = asUser("service_role", OWNER, insertReply(conv, inbound));
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /idx_whatsapp_messages_one_reply_per_inbound/);
  });

  pgTest("ordinary outbound rows (no reply_to_message_id) are unaffected", () => {
    const conv = newConversation();
    for (let i = 0; i < 2; i++) {
      const r = asUser(
        "service_role",
        OWNER,
        `INSERT INTO public.whatsapp_messages (organization_id, whatsapp_connection_id, conversation_id, direction, status)
         VALUES ('${ORG}', '${CONN}', '${conv}', 'outbound', 'queued');`,
      );
      assert.equal(r.status, 0, r.stderr);
    }
  });
});

describe("migration: a connection's agent must be in the connection's organization", () => {
  pgTest("the server can't assign another organization's agent", () => {
    const r = asUser(
      "service_role",
      OWNER,
      `UPDATE public.whatsapp_connections SET agent_config_id = '${OTHER_AGENT}' WHERE id = '${CONN}';`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /WHATSAPP_AGENT_NOT_IN_ORGANIZATION/);
  });

  pgTest(
    "a signed-in member can't either, through their direct UPDATE (agent_config_id) grant",
    () => {
      const r = asUser(
        "authenticated",
        OWNER,
        `UPDATE public.whatsapp_connections SET agent_config_id = '${OTHER_AGENT}' WHERE id = '${CONN}';`,
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /WHATSAPP_AGENT_NOT_IN_ORGANIZATION/);
      assert.deepEqual(
        rows(`SELECT agent_config_id FROM public.whatsapp_connections WHERE id = '${CONN}';`),
        [AGENT],
      );
    },
  );

  pgTest("their own agent, or none, is fine", () => {
    for (const value of ["NULL", `'${AGENT}'`]) {
      const r = asUser(
        "authenticated",
        OWNER,
        `UPDATE public.whatsapp_connections SET agent_config_id = ${value} WHERE id = '${CONN}';`,
      );
      assert.equal(r.status, 0, r.stderr);
    }
  });

  pgTest("the trigger function can't be called directly by browsers", () => {
    for (const role of ["anon", "authenticated"]) {
      assert.deepEqual(
        rows(
          `SELECT has_function_privilege('${role}', 'public.whatsapp_connection_agent_same_org()', 'EXECUTE');`,
        ),
        ["f"],
      );
    }
  });
});

describe("customers: read-only, own organization only", () => {
  pgTest("a member can't change AI/handoff state or write messages directly", () => {
    const conv = newConversation();
    const inbound = newInbound(conv);
    for (const statement of [
      `UPDATE public.whatsapp_conversations SET ai_enabled = false WHERE id = '${conv}';`,
      `UPDATE public.whatsapp_messages SET status = 'read' WHERE id = '${inbound}';`,
      insertReply(conv, randomUUID()),
    ]) {
      const r = asUser("authenticated", OWNER, statement);
      assert.notEqual(r.status, 0, statement);
      assert.match(r.stderr, /permission denied/);
    }
  });

  pgTest(
    "a member sees their own organization's conversations and messages, never another's",
    () => {
      const mine = newConversation();
      newInbound(mine, "mine");
      const theirs = newConversation(OTHER_ORG, OTHER_CONN);
      newInbound(theirs, "theirs", OTHER_ORG, OTHER_CONN);
      const seen = (user: string) =>
        asUser(
          "authenticated",
          user,
          `\\pset format unaligned\n\\pset tuples_only on\nSELECT DISTINCT organization_id FROM public.whatsapp_messages;\nSELECT DISTINCT organization_id || '|' || ai_enabled FROM public.whatsapp_conversations;`,
        ).stdout;
      assert.ok(seen(OWNER).includes(ORG));
      assert.ok(!seen(OWNER).includes(OTHER_ORG));
      assert.ok(seen(OTHER_USER).includes(OTHER_ORG));
      assert.ok(!seen(OTHER_USER).includes(ORG));
    },
  );

  pgTest("browsers still can't read the stored access token", () => {
    const r = asUser(
      "authenticated",
      OWNER,
      "SELECT access_token_ciphertext FROM public.whatsapp_connections;",
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied/);
  });

  pgTest("the server role has what the WhatsApp code uses", () => {
    for (const [table, privileges] of [
      ["whatsapp_messages", ["SELECT", "INSERT", "UPDATE"]],
      ["whatsapp_conversations", ["SELECT", "INSERT", "UPDATE"]],
      ["whatsapp_connections", ["SELECT", "UPDATE"]],
      ["webhook_events", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
      ["contacts", ["SELECT"]],
      ["agent_configs", ["SELECT"]],
    ] as const) {
      for (const p of privileges) {
        assert.deepEqual(
          rows(`SELECT has_table_privilege('service_role', 'public.${table}', '${p}');`),
          ["t"],
          `${table} ${p}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The real modules through supabase-js → PostgREST → PostgreSQL.

function fakeMeta(status = 200) {
  const sent: { to: string; body: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    sent.push({ to: payload.to, body: payload.text?.body ?? payload.template?.name });
    return new Response(
      JSON.stringify(
        status === 200 ? { messages: [{ id: `wamid.out.${randomUUID()}` }] } : { error: {} },
      ),
      { status },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}
const okAi = (async () => ({ reply: "We open at 9am." })) as never;

function webhookBody(messages: unknown[], phoneNumberId = PN, statuses: unknown[] = []) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: "919800000001", profile: { name: "Asha" } }],
              messages,
              statuses,
            },
          },
        ],
      },
    ],
  });
}
const text = (id: string, body: string, ts: number, from = "919800000001") => ({
  id,
  from,
  type: "text",
  timestamp: String(ts),
  text: { body },
});

describe("real PostgREST: inbound webhook", () => {
  restTest(
    "stores a message once, keeps the window start monotonic (quoted-timestamp or() filter), dedupes redeliveries",
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const newer = `wamid.${randomUUID()}`;
      const older = `wamid.${randomUUID()}`;
      const first = await processInboundWhatsAppWebhook(client, {
        rawBody: webhookBody([text(newer, "newer", now - 60)]),
        eventId: randomUUID(),
      });
      assert.equal(first.newInboundTextMessageIds.length, 1);
      const late = await processInboundWhatsAppWebhook(client, {
        rawBody: webhookBody([text(older, "older", now - 600), text(newer, "newer", now - 60)]),
        eventId: randomUUID(),
      });
      assert.equal(late.newInboundTextMessageIds.length, 1, "only the late message is new");
      assert.deepEqual(
        rows(
          `SELECT extract(epoch FROM last_inbound_at)::bigint || '|' || last_message_preview FROM public.whatsapp_conversations WHERE whatsapp_connection_id = '${CONN}' AND wa_id = '919800000001';`,
        ),
        [`${now - 60}|newer`],
      );
      const evt = randomUUID();
      const body = webhookBody([text(`wamid.${randomUUID()}`, "x", now)]);
      await processInboundWhatsAppWebhook(client, { rawBody: body, eventId: evt });
      assert.equal(
        (await processInboundWhatsAppWebhook(client, { rawBody: body, eventId: evt })).outcome,
        "duplicate",
      );
    },
  );

  restTest("delivery statuses are monotonic and scoped to the named connection", async () => {
    const conv = newConversation();
    const wamid = `wamid.${randomUUID()}`;
    sql(`INSERT INTO public.whatsapp_messages (organization_id, whatsapp_connection_id, conversation_id, wa_message_id, direction, status)
         VALUES ('${ORG}', '${CONN}', '${conv}', '${wamid}', 'outbound', 'sent');`);
    const status = (s: string, pn = PN) =>
      processInboundWhatsAppWebhook(client, {
        rawBody: webhookBody([], pn, [{ id: wamid, status: s }]),
        eventId: randomUUID(),
      });
    await status("read", OTHER_PN);
    const current = () =>
      rows(`SELECT status FROM public.whatsapp_messages WHERE wa_message_id = '${wamid}';`);
    assert.deepEqual(current(), ["sent"], "another tenant's number can't touch it");
    await status("read");
    await status("delivered");
    await status("failed");
    assert.deepEqual(current(), ["read"]);
  });
});

describe("real PostgREST: outbound and AI replies", () => {
  restTest(
    "a staff send is idempotent per key (metadata->>idempotency_key filter) and rate-counted (count head)",
    async () => {
      const conv = newConversation();
      const meta = fakeMeta();
      const send = (key: string) =>
        sendWhatsAppConversationMessage(
          client,
          {
            organizationId: ORG,
            conversationId: conv,
            payload: { kind: "text", body: "Hi from staff" },
            idempotencyKey: key,
            origin: "staff",
          },
          { fetchImpl: meta.fetchImpl, sleep: async () => {} },
        );
      assert.equal((await send("staff:a")).outcome, "sent");
      assert.deepEqual(await send("staff:a"), { outcome: "duplicate" });
      assert.equal(meta.sent.length, 1);
      assert.deepEqual(
        await sendWhatsAppConversationMessage(
          client,
          {
            organizationId: OTHER_ORG,
            conversationId: conv,
            payload: { kind: "text", body: "x" },
            idempotencyKey: "staff:b",
            origin: "staff",
          },
          { fetchImpl: meta.fetchImpl },
        ),
        { outcome: "refused", reason: "not_found" },
      );
      for (let i = 0; i < 9; i++) await send(`staff:n${i}`);
      assert.deepEqual(await send("staff:over"), { outcome: "refused", reason: "rate_limited" });
    },
  );

  restTest(
    "an AI reply is sent once; concurrent workers lose the claim through the real 23505",
    async () => {
      const conv = newConversation();
      const inbound = newInbound(conv, "When do you open?");
      const meta = fakeMeta();
      const deps = { generateReply: okAi, fetchImpl: meta.fetchImpl, sleep: async () => {} };
      const outcomes = await Promise.all([
        replyToInboundWhatsAppMessage(client, inbound, deps),
        replyToInboundWhatsAppMessage(client, inbound, deps),
      ]);
      assert.deepEqual(outcomes.sort(), ["duplicate", "replied"]);
      assert.equal(meta.sent.length, 1);
      assert.deepEqual(
        rows(
          `SELECT status || '|' || content || '|' || attempts FROM public.whatsapp_messages WHERE reply_to_message_id = '${inbound}';`,
        ),
        ["sent|We open at 9am.|1"],
      );
    },
  );

  restTest(
    "a stale empty claim is taken over (metadata->>claimed_at match on an ISO timestamp)",
    async () => {
      const conv = newConversation();
      const inbound = newInbound(conv, "Are you open Sunday?");
      const claimedAt = new Date(Date.now() - STALE_CLAIM_MS - 5_000).toISOString();
      sql(`INSERT INTO public.whatsapp_messages
           (organization_id, whatsapp_connection_id, conversation_id, direction, message_type, status, reply_to_message_id, metadata)
         VALUES ('${ORG}', '${CONN}', '${conv}', 'outbound', 'text', 'queued', '${inbound}',
                 jsonb_build_object('origin', 'ai', 'claimed_at', '${claimedAt}', 'takeovers', 0));`);
      const meta = fakeMeta();
      const outcome = await replyToInboundWhatsAppMessage(client, inbound, {
        generateReply: okAi,
        fetchImpl: meta.fetchImpl,
        sleep: async () => {},
      });
      assert.equal(outcome, "replied");
      assert.deepEqual(
        rows(
          `SELECT status || '|' || (metadata->>'takeovers') FROM public.whatsapp_messages WHERE reply_to_message_id = '${inbound}';`,
        ),
        ["sent|1"],
      );
    },
  );

  restTest(
    "handoff turns AI off; the recovery sweep then answers nothing more in that conversation",
    async () => {
      const conv = newConversation();
      const ask = newInbound(conv, "Can I talk to a person?");
      const meta = fakeMeta();
      const deps = { generateReply: okAi, fetchImpl: meta.fetchImpl, sleep: async () => {} };
      assert.equal(await replyToInboundWhatsAppMessage(client, ask, deps), "handoff");
      assert.deepEqual(
        rows(
          `SELECT ai_enabled || '|' || (handoff_requested_at IS NOT NULL) FROM public.whatsapp_conversations WHERE id = '${conv}';`,
        ),
        ["false|true"],
      );
      const later = newInbound(conv, "hello?");
      const summary = await recoverPendingWhatsAppReplies(client, deps);
      assert.equal(summary.results[later], "skipped_ai_disabled");
      assert.equal(summary.results[ask], undefined, "already answered");
      // The sweep is global (other tests' messages may be answered too); this conversation got only the acknowledgement.
      assert.deepEqual(
        rows(
          `SELECT count(*) FROM public.whatsapp_messages WHERE conversation_id = '${conv}' AND direction = 'outbound';`,
        ),
        ["1"],
      );
    },
  );
});
