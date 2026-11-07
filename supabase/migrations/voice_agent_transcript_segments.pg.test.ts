import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapCluster,
  makeExecSql,
  registerSignalCleanup,
  teardownCluster,
  type Cluster,
  type RunResult,
} from "./pg-test-cluster.ts";

/**
 * REAL-PostgreSQL concurrency coverage for LiveKit transcript persistence
 * (20261107090000_voice_agent_transcript_segments.sql). Every migration in
 * this directory is replayed, in filename order, onto a brand-new disposable
 * cluster, and the function is called from SEPARATE psql connections running
 * at the same time (child processes), not sequentially and not a mock.
 *
 * Covers: simultaneous checkpoints of one call; a checkpoint racing the
 * final report; duplicate retries; out-of-order checkpoints; several agent
 * jobs (reconnects) contributing segments; repeated final reports; identity
 * binding; invalid input; and who may call the function or read the table.
 * A control test first shows the old read-merge-write pattern losing a
 * segment under the same concurrency.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

const SUPABASE_STANDIN = `
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
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`;

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregisterSignalCleanup: (() => void) | null = null;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const OWNER = randomUUID();
const OTHER_USER = randomUUID();
const T0 = Date.UTC(2026, 10, 7, 5, 0, 0);

/** Runs SQL on its own connection and returns unaligned, tuples-only output lines. */
function rows(sql: string): string[] {
  const result = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  if (result.status !== 0) throw new Error(`SQL failed: ${result.stderr}\n${sql}`);
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}

/** Runs SQL on a NEW connection without waiting: callers start several and await them together. */
function runAsync(sql: string): Promise<RunResult & { ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const c = cluster!;
    const args = ["-h", c.sockDir, "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-X"];
    args.push("-A", "-t", "-f", "-");
    const child = c.useSu
      ? spawn("su", ["postgres", "-c", [`${c.pgBinDir}psql`, ...args].join(" ")])
      : spawn(`${c.pgBinDir}psql`, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) =>
      resolve({ status: code ?? 1, stdout, stderr, ms: Date.now() - started }),
    );
    child.stdin.write(sql);
    child.stdin.end();
  });
}

const turns = (start: number, n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => ({
    role: (start + i) % 2 ? "user" : "assistant",
    text: `${tag} ${start + i}`,
    at: new Date(T0 + (start + i) * 1000).toISOString(),
  }));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** One call to the function, as the Worker makes it (service_role). */
function storeSql(
  callId: string,
  o: { sip?: string | null; segment: string; turns: unknown[]; final: boolean; lang?: string },
): string {
  const sip = o.sip === undefined ? "'SIP-" + callId + "'" : o.sip === null ? "NULL" : lit(o.sip);
  return `SET ROLE service_role;
SELECT outcome || '|' || coalesce(total_turns::text, '') FROM public.store_voice_agent_transcript_segment(
  '${callId}', ${sip}, ${lit(o.segment)}, ${lit(JSON.stringify(o.turns))}::jsonb, ${o.final}, ${lit(o.lang ?? "te-IN")});`;
}

function newCall(o: { provider?: string; sip?: string | null; org?: string } = {}): string {
  const id = randomUUID();
  const sip = o.sip === undefined ? `SIP-${id}` : o.sip;
  rows(`INSERT INTO public.call_logs (id, organization_id, provider, provider_call_id, direction, status)
        VALUES ('${id}', '${o.org ?? ORG}', '${o.provider ?? "livekit_sip"}', ${sip === null ? "NULL" : lit(sip)}, 'inbound', 'in_progress');`);
  return id;
}

function stored(callId: string): { texts: string[]; summary: string | null; raw: unknown[] } {
  const [t, s] = rows(
    `SELECT coalesce(transcript::text, 'null') FROM public.call_logs WHERE id = '${callId}';
     SELECT coalesce(summary, '<null>') FROM public.call_logs WHERE id = '${callId}';`,
  );
  const raw = (JSON.parse(t!) ?? []) as { text: string }[];
  return { texts: raw.map((x) => x.text), summary: s === "<null>" ? null : s!, raw };
}

function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregisterSignalCleanup = registerSignalCleanup(() => cluster);
  const standin = execSql(SUPABASE_STANDIN);
  if (standin.status !== 0) {
    setupFailure = `Supabase auth/role stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATION_FILES) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  // The migration is idempotent: applying it a second time changes nothing.
  const again = execSql(
    readFileSync(join(migrationsDir, "20261107090000_voice_agent_transcript_segments.sql"), "utf8"),
  );
  if (again.status !== 0) {
    setupFailure = `re-applying the migration failed: ${again.stderr}`;
    return;
  }
  const seed = execSql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${ORG}', 'Smile Dental', '${OWNER}'), ('${OTHER_ORG}', 'Other Clinic', '${OTHER_USER}');
    INSERT INTO public.organization_members (organization_id, user_id) VALUES
      ('${ORG}', '${OWNER}'), ('${OTHER_ORG}', '${OTHER_USER}');
  `);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("control: the old read-merge-write pattern loses a segment under concurrency", () => {
  test("two connections read, then both write: the first writer's segment is gone", async (t) => {
    if (!ready(t)) return;
    const id = newCall();
    // What sessions.server.ts did before: read the transcript, merge in the
    // application, then an unconditional UPDATE. Both read before either writes.
    const oldWrite = (segment: string, text: string, delay: number) =>
      runAsync(`BEGIN;
        CREATE TEMP TABLE r AS SELECT coalesce(transcript, '[]'::jsonb) AS t FROM public.call_logs WHERE id = '${id}';
        COMMIT;
        SELECT pg_sleep(${delay});
        UPDATE public.call_logs SET transcript = (SELECT t FROM r) ||
          jsonb_build_array(jsonb_build_object('role','user','text','${text}','at','2026-11-07T05:00:00Z','seg','${segment}'))
          WHERE id = '${id}';`);
    const [a, b] = await Promise.all([
      oldWrite("AJ_a", "from a", 0.3),
      oldWrite("AJ_b", "from b", 0.6),
    ]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(stored(id).texts, ["from b"], "the race is real: segment a was silently lost");
  });
});

describe("store_voice_agent_transcript_segment: concurrent writers never lose turns", () => {
  test("simultaneous checkpoints from many connections (8 jobs x 3 snapshots): every segment, longest snapshot, once", async (t) => {
    if (!ready(t)) return;
    const id = newCall();
    const calls: Promise<RunResult>[] = [];
    for (let j = 0; j < 8; j++)
      for (const n of [2, 5, 3])
        calls.push(
          runAsync(
            storeSql(id, { segment: `AJ_${j}`, turns: turns(j * 10, n, `j${j}`), final: false }),
          ),
        );
    const results = await Promise.all(calls);
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const { texts, summary } = stored(id);
    const expected = Array.from({ length: 8 }, (_, j) =>
      turns(j * 10, 5, `j${j}`).map((x) => x.text),
    ).flat();
    assert.deepEqual(texts, expected);
    assert.equal(new Set(texts).size, texts.length, "no duplicates");
    assert.equal(summary, "40 turns · te-IN");
    assert.equal(
      rows(`SELECT count(*) FROM public.call_transcript_segments WHERE call_id = '${id}';`)[0],
      "8",
    );
  });

  test("a writer holding the call waits the other out: the second sees the first's segment (row lock)", async (t) => {
    if (!ready(t)) return;
    const id = newCall();
    // Connection A stores its segment and keeps its transaction open for 1.5 s.
    const a =
      runAsync(`BEGIN;\n${storeSql(id, { segment: "AJ_a", turns: turns(0, 3, "a"), final: false })}
      SELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((r) => setTimeout(r, 400));
    // Connection B, a different job, writes meanwhile: it must wait, then merge A's committed segment.
    const b = await runAsync(
      storeSql(id, { segment: "AJ_b", turns: turns(10, 2, "b"), final: true }),
    );
    const ra = await a;
    assert.equal(ra.status, 0, ra.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.ok(b.ms >= 800, `B waited for A's lock (${b.ms} ms)`);
    assert.deepEqual(stored(id).texts, ["a 0", "a 1", "a 2", "b 10", "b 11"]);
  });

  test("a stale checkpoint racing the final report never overwrites it, whichever commits first", async (t) => {
    if (!ready(t)) return;
    for (const order of ["final-first", "checkpoint-first"] as const) {
      const id = newCall();
      const final = storeSql(id, { segment: "AJ_1", turns: turns(0, 6, "final"), final: true });
      const stale = storeSql(id, { segment: "AJ_1", turns: turns(0, 6, "stale"), final: false });
      const [first, second] = order === "final-first" ? [final, stale] : [stale, final];
      const held = runAsync(`BEGIN;\n${first}\nSELECT pg_sleep(0.8);\nCOMMIT;`);
      await new Promise((r) => setTimeout(r, 200));
      const r2 = await runAsync(second);
      const r1 = await held;
      assert.equal(r1.status, 0, r1.stderr);
      assert.equal(r2.status, 0, r2.stderr);
      assert.deepEqual(
        stored(id).texts,
        turns(0, 6, "final").map((x) => x.text),
        order,
      );
      // and a later, longer checkpoint for the finalized segment changes nothing either
      rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 9, "late"), final: false }));
      assert.deepEqual(
        stored(id).texts,
        turns(0, 6, "final").map((x) => x.text),
        `${order}: late`,
      );
    }
  });

  test("ten simultaneous retries of the same checkpoint: stored once, the rest unchanged", async (t) => {
    if (!ready(t)) return;
    const id = newCall();
    const sql = storeSql(id, { segment: "AJ_1", turns: turns(0, 4, "r"), final: false });
    const results = await Promise.all(Array.from({ length: 10 }, () => runAsync(sql)));
    const outcomes = results.map((r) => (assert.equal(r.status, 0, r.stderr), r.stdout.trim()));
    assert.equal(outcomes.filter((o) => o === "stored|4").length, 1, outcomes.join(","));
    assert.equal(outcomes.filter((o) => o === "unchanged|").length, 9, outcomes.join(","));
    assert.deepEqual(stored(id).texts, ["r 0", "r 1", "r 2", "r 3"]);
  });
});

describe("store_voice_agent_transcript_segment: semantics", () => {
  test("out-of-order checkpoints: an older, shorter snapshot after a newer one changes nothing", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    assert.deepEqual(
      rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 6, "a"), final: false })),
      ["stored|6"],
    );
    assert.deepEqual(
      rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 4, "a"), final: false })),
      ["unchanged|"],
    );
    assert.equal(stored(id).texts.length, 6);
  });

  test("reconnect: the crashed job's turns stay; the new job's segment is merged in time order", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    rows(storeSql(id, { segment: "AJ_old", turns: turns(0, 4, "old"), final: false }));
    rows(storeSql(id, { segment: "AJ_new", turns: turns(10, 2, "new"), final: false }));
    rows(storeSql(id, { segment: "AJ_new", turns: turns(10, 5, "new"), final: true }));
    assert.deepEqual(stored(id).texts, [
      ...turns(0, 4, "old").map((x) => x.text),
      ...turns(10, 5, "new").map((x) => x.text),
    ]);
  });

  test("repeated final reports: equal or shorter change nothing, longer replaces", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    assert.deepEqual(
      rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 6, "f"), final: true })),
      ["stored|6"],
    );
    assert.deepEqual(
      rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 6, "f"), final: true })),
      ["unchanged|"],
    );
    assert.deepEqual(
      rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 3, "f"), final: true })),
      ["unchanged|"],
    );
    assert.deepEqual(
      rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 8, "f"), final: true })),
      ["stored|8"],
    );
  });

  test("a final report shorter than the stored checkpoint finalizes it without losing turns", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 8, "a"), final: false }));
    assert.deepEqual(
      rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 5, "a"), final: true })),
      ["unchanged|"],
    );
    assert.equal(
      rows(`SELECT final FROM public.call_transcript_segments WHERE call_id = '${id}';`)[0],
      "t",
    );
    rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 9, "late"), final: false }));
    assert.equal(stored(id).texts.length, 8);
  });

  test("dashboard shape: role/text/at plus seg (named jobs only) and n; extra input keys dropped; deterministic ties", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    const at = new Date(T0).toISOString();
    rows(
      storeSql(id, {
        segment: "",
        turns: [{ role: "assistant", text: "legacy", at, secret: "dropped" }],
        final: false,
      }),
    );
    rows(
      storeSql(id, {
        segment: "AJ_b",
        turns: [
          { role: "assistant", text: "b first", at },
          { role: "user", text: "b second", at },
        ],
        final: false,
      }),
    );
    rows(
      storeSql(id, {
        segment: "AJ_a",
        turns: [{ role: "user", text: "a only", at }],
        final: false,
      }),
    );
    const { raw, summary } = stored(id);
    assert.deepEqual(raw, [
      { role: "assistant", text: "legacy", at, n: 0 },
      { role: "user", text: "a only", at, seg: "AJ_a", n: 0 },
      { role: "assistant", text: "b first", at, seg: "AJ_b", n: 0 },
      { role: "user", text: "b second", at, seg: "AJ_b", n: 1 },
    ]);
    assert.equal(summary, "4 turns · te-IN");
  });
});

describe("store_voice_agent_transcript_segment: identity, validation and access", () => {
  test("binding: wrong SIP call id, a checkpoint without one, or a call with none recorded are refused and write nothing", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    const unrecorded = newCall({ sip: null });
    assert.deepEqual(
      rows(
        storeSql(id, { sip: "SIP-other", segment: "AJ_1", turns: turns(0, 2, "x"), final: false }),
      ),
      ["binding_mismatch|"],
    );
    assert.deepEqual(
      rows(
        storeSql(id, { sip: "SIP-other", segment: "AJ_1", turns: turns(0, 2, "x"), final: true }),
      ),
      ["binding_mismatch|"],
    );
    assert.deepEqual(
      rows(storeSql(id, { sip: null, segment: "AJ_1", turns: turns(0, 2, "x"), final: false })),
      ["binding_mismatch|"],
    );
    assert.deepEqual(
      rows(
        storeSql(unrecorded, {
          sip: "SIP-x",
          segment: "AJ_1",
          turns: turns(0, 2, "x"),
          final: false,
        }),
      ),
      ["binding_mismatch|"],
    );
    assert.equal(stored(id).raw.length, 0);
    assert.equal(
      rows(
        `SELECT count(*) FROM public.call_transcript_segments WHERE call_id IN ('${id}', '${unrecorded}');`,
      )[0],
      "0",
    );
  });

  test("unknown call, or a call of another provider (Worker runtime): unknown_call, nothing written", (t) => {
    if (!ready(t)) return;
    const worker = newCall({ provider: "vobiz" });
    assert.deepEqual(
      rows(
        storeSql(randomUUID(), {
          sip: null,
          segment: "AJ_1",
          turns: turns(0, 1, "x"),
          final: true,
        }),
      ),
      ["unknown_call|"],
    );
    assert.deepEqual(
      rows(storeSql(worker, { segment: "AJ_1", turns: turns(0, 1, "x"), final: true })),
      ["unknown_call|"],
    );
    assert.equal(stored(worker).raw.length, 0);
  });

  test("invalid input raises and writes nothing (never a false success)", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    const bad: unknown[][] = [
      [{ role: "system", text: "x", at: new Date(T0).toISOString() }],
      [{ role: "user", text: "", at: new Date(T0).toISOString() }],
      [{ role: "user", text: "x".repeat(4001), at: new Date(T0).toISOString() }],
      [{ role: "user", text: "x", at: "not a time" }],
      [{ role: "user", text: 5, at: new Date(T0).toISOString() }],
      ["not an object"],
      turns(0, 401, "x"),
    ];
    for (const b of bad) {
      const r = execSql!(storeSql(id, { segment: "AJ_1", turns: b, final: false }));
      assert.notEqual(r.status, 0, JSON.stringify(b).slice(0, 80));
    }
    const badSeg = execSql!(
      storeSql(id, { segment: "AJ/../x", turns: turns(0, 1, "x"), final: false }),
    );
    assert.notEqual(badSeg.status, 0);
    assert.equal(stored(id).raw.length, 0);
  });

  test("only service_role may call the function; anon/authenticated can neither call it nor read segments", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 2, "x"), final: false }));
    for (const role of ["anon", "authenticated"]) {
      const call = execSql!(`SET ROLE ${role};
        SELECT * FROM public.store_voice_agent_transcript_segment('${id}', 'SIP-${id}', 'AJ_2', '[]'::jsonb, false, 'en');`);
      assert.notEqual(call.status, 0, `${role} executed the function`);
      assert.match(call.stderr, /permission denied/);
      const read = execSql!(
        `SET ROLE ${role}; SELECT count(*) FROM public.call_transcript_segments;`,
      );
      assert.notEqual(read.status, 0, `${role} read the segments table`);
    }
  });

  test("tenant isolation: the dashboard transcript is visible to the call's organization only", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 2, "x"), final: true }));
    const visible = (user: string) =>
      rows(`SET ROLE authenticated;
        SELECT set_config('request.jwt.claim.sub', '${user}', false);
        SELECT count(*) FROM public.call_logs WHERE id = '${id}' AND transcript IS NOT NULL;
        RESET ROLE;`).filter((l) => l !== user);
    assert.deepEqual(visible(OWNER), ["1"]);
    assert.deepEqual(visible(OTHER_USER), ["0"]);
  });

  test("deleting the call removes its segments (ON DELETE CASCADE)", (t) => {
    if (!ready(t)) return;
    const id = newCall();
    rows(storeSql(id, { segment: "AJ_1", turns: turns(0, 2, "x"), final: false }));
    rows(`DELETE FROM public.call_logs WHERE id = '${id}';`);
    assert.equal(
      rows(`SELECT count(*) FROM public.call_transcript_segments WHERE call_id = '${id}';`)[0],
      "0",
    );
  });
});
