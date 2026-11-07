/**
 * The local SIP smoke test's safety rails (deploy/local/smoke-lib.ts): it
 * must never modify or delete production SIP objects, must refuse a server
 * that is not demonstrably local, and must clean up only what it created.
 * In-memory SIP API; no network.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_RULE_NAME,
  INBOUND_TRUNK_NAME,
  OUTBOUND_TRUNK_NAME,
} from "../deploy/livekit/sip-provisioning.ts";
import {
  assertLocalTarget,
  assertSmokeName,
  assertWebhookProof,
  missingWebhookEvents,
  newRunId,
  preflight,
  PROTECTED_SIP_NAMES,
  selectRunRoom,
  SmokeGuardError,
  smokeNames,
  SmokeSipRun,
  type SmokeSipApi,
} from "../deploy/local/smoke-lib.ts";

const PROD = [INBOUND_TRUNK_NAME, OUTBOUND_TRUNK_NAME, DISPATCH_RULE_NAME];
const KEY = "APIlocal0123456789ab";

interface Obj {
  id: string;
  name: string;
  numbers?: string[];
}
interface Fake {
  inbound: Obj[];
  outbound: Obj[];
  rules: Obj[];
  calls: string[];
  fail: Set<string>;
}
let f: Fake;
let seq = 0;

function api(): SmokeSipApi {
  const go = (m: string) => {
    f.calls.push(m);
    if (f.fail.has(m)) throw new Error(`injected ${m} failure`);
  };
  const trunk = (o: Obj) => ({ name: o.name, sipTrunkId: o.id, numbers: o.numbers ?? [] });
  const rule = (o: Obj) => ({ name: o.name, sipDispatchRuleId: o.id });
  const a = {
    async listSipInboundTrunk() {
      go("listSipInboundTrunk");
      return f.inbound.map(trunk);
    },
    async listSipOutboundTrunk() {
      go("listSipOutboundTrunk");
      return f.outbound.map(trunk);
    },
    async listSipDispatchRule() {
      go("listSipDispatchRule");
      return f.rules.map(rule);
    },
    async createSipInboundTrunk(name: string, numbers: string[]) {
      go("createSipInboundTrunk");
      const o = { id: `ST_${++seq}`, name, numbers };
      f.inbound.push(o);
      return trunk(o);
    },
    async createSipDispatchRule(_r: unknown, opts: { name: string }) {
      go("createSipDispatchRule");
      const o = { id: `SDR_${++seq}`, name: opts.name };
      f.rules.push(o);
      return rule(o);
    },
    async deleteSipTrunk(id: string) {
      go(`deleteSipTrunk:${id}`);
      f.inbound = f.inbound.filter((o) => o.id !== id);
      f.outbound = f.outbound.filter((o) => o.id !== id);
    },
    async deleteSipDispatchRule(id: string) {
      go(`deleteSipDispatchRule:${id}`);
      f.rules = f.rules.filter((o) => o.id !== id);
    },
  };
  return a as unknown as SmokeSipApi;
}
const deletes = () => f.calls.filter((c) => c.startsWith("delete"));
const creates = () => f.calls.filter((c) => c.startsWith("create"));

beforeEach(() => {
  f = { inbound: [], outbound: [], rules: [], calls: [], fail: new Set() };
});

describe("smoke names never reach production names", () => {
  test("per-run names, room prefix and number are distinct from production", () => {
    for (let i = 0; i < 50; i++) {
      const n = smokeNames(newRunId());
      for (const x of [n.trunk, n.rule]) {
        assert.ok(!PROTECTED_SIP_NAMES.has(x));
        assert.match(x, /^clickai-local-smoke-[0-9a-f]{12}-(inbound|dispatch)$/);
      }
      assert.ok(n.roomPrefix.startsWith("smoke-call-") && !n.roomPrefix.startsWith("call-"));
      assert.match(n.number, /^\+9112345\d{5}$/);
    }
    assert.equal(PROTECTED_SIP_NAMES.size, 3);
    for (const p of PROD) assert.ok(PROTECTED_SIP_NAMES.has(p));
  });
  test("assertSmokeName rejects every production name and any foreign name", () => {
    for (const p of [...PROD, "clickai-local-smoke-", "clickai-local-smoke-xyz-inbound", "other"])
      assert.throws(() => assertSmokeName(p), SmokeGuardError, p);
    assert.throws(() => smokeNames("../../x"), SmokeGuardError);
  });
  test("a run whose names were tampered to production names cannot be constructed", () => {
    const n = smokeNames(newRunId());
    for (const p of PROD) {
      assert.throws(() => new SmokeSipRun(api(), { ...n, trunk: p }), SmokeGuardError);
      assert.throws(() => new SmokeSipRun(api(), { ...n, rule: p }), SmokeGuardError);
    }
  });
});

describe("the target must be demonstrably local", () => {
  test("loopback http/ws with an init-env.sh key is accepted", () => {
    for (const url of ["http://127.0.0.1:7880", "ws://localhost:7880", "http://[::1]:7880"])
      assert.doesNotThrow(() => assertLocalTarget({ url, apiKey: KEY }));
  });
  test("remote hosts, TLS URLs and non-local keys are refused", () => {
    for (const url of [
      "http://10.0.0.5:7880",
      "https://127.0.0.1:7880",
      "wss://livekit.example.in",
      "http://livekit.example.in:7880",
      "not a url",
    ])
      assert.throws(() => assertLocalTarget({ url, apiKey: KEY }), SmokeGuardError, url);
    for (const apiKey of [
      "APIprod0123456789ab",
      "APIlocal",
      "APIlocal0123",
      "",
      "APIlocalXYZ456789abc",
    ])
      assert.throws(
        () => assertLocalTarget({ url: "http://127.0.0.1:7880", apiKey }),
        SmokeGuardError,
        apiKey,
      );
  });
  test("webhook proof: a verified webhook for this run's room must have arrived here", () => {
    const room = "smoke-dispatch-abc";
    assert.throws(() => assertWebhookProof([], room), SmokeGuardError);
    assert.throws(() => assertWebhookProof([{ ok: true, room: "x" }], room), SmokeGuardError);
    assert.throws(() => assertWebhookProof([{ ok: false, room }], room), SmokeGuardError);
    assert.throws(() => assertWebhookProof([{ ok: true, room }], null), SmokeGuardError);
    assert.doesNotThrow(() => assertWebhookProof([{ ok: true, room }], room));
  });
  test("preflight refuses a server holding any production SIP object, before creating anything", async () => {
    const n = smokeNames(newRunId());
    const cases: Array<() => void> = [
      () => f.inbound.push({ id: "ST_p", name: INBOUND_TRUNK_NAME, numbers: ["+918000000000"] }),
      () => f.outbound.push({ id: "ST_o", name: OUTBOUND_TRUNK_NAME }),
      () => f.rules.push({ id: "SDR_p", name: DISPATCH_RULE_NAME }),
    ];
    for (const seed of cases) {
      f = { inbound: [], outbound: [], rules: [], calls: [], fail: new Set() };
      seed();
      await assert.rejects(preflight(api(), n), /production SIP objects/);
      assert.deepEqual(creates(), []);
      assert.deepEqual(deletes(), []);
    }
  });
  test("preflight refuses a number collision and reports (never deletes) stale smoke objects", async () => {
    const n = smokeNames("123456789abc");
    f.inbound.push({ id: "ST_x", name: "someone-else", numbers: [n.number] });
    await assert.rejects(preflight(api(), n), /already claims/);
    f.inbound = [
      { id: "ST_old", name: smokeNames("aaaaaaaaaaaa").trunk, numbers: ["+911234500000"] },
    ];
    f.rules = [{ id: "SDR_old", name: smokeNames("aaaaaaaaaaaa").rule }];
    assert.deepEqual((await preflight(api(), n)).length, 2);
    assert.deepEqual(deletes(), []);
  });
  test("preflight propagates a listing failure (no create)", async () => {
    f.fail.add("listSipOutboundTrunk");
    await assert.rejects(preflight(api(), smokeNames(newRunId())), /injected/);
    assert.deepEqual(creates(), []);
  });
});

describe("cleanup deletes only what this run created", () => {
  const seedOthers = () => {
    // Production objects appearing after preflight (e.g. a race) and an older run's objects.
    f.inbound.push({ id: "ST_prod", name: INBOUND_TRUNK_NAME, numbers: ["+918000000000"] });
    f.outbound.push({ id: "ST_prodout", name: OUTBOUND_TRUNK_NAME });
    f.rules.push({ id: "SDR_prod", name: DISPATCH_RULE_NAME });
    f.inbound.push({ id: "ST_old", name: smokeNames("bbbbbbbbbbbb").trunk });
    f.rules.push({ id: "SDR_old", name: smokeNames("bbbbbbbbbbbb").rule });
  };
  test("happy path: own trunk and rule deleted by id; production and other runs untouched", async () => {
    const run = new SmokeSipRun(api(), smokeNames(newRunId()));
    await run.setup({ allowedAddresses: ["172.16.0.0/12"], agentName: "clickai-receptionist" });
    seedOthers();
    const { trunkId, ruleId } = run.created;
    const res = await run.cleanup();
    assert.deepEqual(res.failed, []);
    assert.equal(res.deleted.length, 2);
    assert.deepEqual(deletes(), [`deleteSipDispatchRule:${ruleId}`, `deleteSipTrunk:${trunkId}`]);
    assert.deepEqual([...f.inbound, ...f.outbound, ...f.rules].map((o) => o.id).sort(), [
      "SDR_old",
      "SDR_prod",
      "ST_old",
      "ST_prod",
      "ST_prodout",
    ]);
  });
  test("an id that now carries a production (or any other) name is skipped, never deleted", async () => {
    const run = new SmokeSipRun(api(), smokeNames(newRunId()));
    await run.setup({ allowedAddresses: [], agentName: "a" });
    f.inbound[0]!.name = INBOUND_TRUNK_NAME;
    f.rules[0]!.name = "renamed";
    const res = await run.cleanup();
    assert.deepEqual(deletes(), []);
    assert.equal(res.skipped.length, 2);
    assert.equal(f.inbound.length + f.rules.length, 2);
  });
  test("dispatch-rule creation fails: setup throws, cleanup still removes the trunk", async () => {
    f.fail.add("createSipDispatchRule");
    const run = new SmokeSipRun(api(), smokeNames(newRunId()));
    await assert.rejects(run.setup({ allowedAddresses: [], agentName: "a" }), /injected/);
    assert.equal(run.created.ruleId, null);
    const res = await run.cleanup();
    assert.deepEqual(res.deleted, [`inbound trunk ${run.names.trunk}`]);
    assert.deepEqual(f.inbound, []);
  });
  test("trunk creation fails: nothing to clean, no delete call", async () => {
    f.fail.add("createSipInboundTrunk");
    const run = new SmokeSipRun(api(), smokeNames(newRunId()));
    await assert.rejects(run.setup({ allowedAddresses: [], agentName: "a" }));
    const res = await run.cleanup();
    assert.deepEqual(res, { deleted: [], skipped: [], failed: [] });
    assert.deepEqual(deletes(), []);
  });
  test("a delete failure is reported, does not throw, and the other object is still removed", async () => {
    const run = new SmokeSipRun(api(), smokeNames(newRunId()));
    await run.setup({ allowedAddresses: [], agentName: "a" });
    f.fail.add(`deleteSipDispatchRule:${run.created.ruleId}`);
    const res = await run.cleanup();
    assert.equal(res.failed.length, 1);
    assert.deepEqual(res.deleted, [`inbound trunk ${run.names.trunk}`]);
  });
  test("objects already gone are skipped; cleanup before setup does nothing", async () => {
    const empty = new SmokeSipRun(api(), smokeNames(newRunId()));
    assert.deepEqual(await empty.cleanup(), { deleted: [], skipped: [], failed: [] });
    const run = new SmokeSipRun(api(), smokeNames(newRunId()));
    await run.setup({ allowedAddresses: [], agentName: "a" });
    f.inbound = [];
    f.rules = [];
    const res = await run.cleanup();
    assert.equal(res.skipped.length, 2);
    assert.deepEqual(deletes(), []);
  });
});

describe("webhook events and room selection (smoke checks)", () => {
  test("missingWebhookEvents counts only verified events for the given room", () => {
    const w = [
      { ok: true, event: "room_started", room: "r1" },
      { ok: false, event: "participant_joined", room: "r1" },
      { ok: true, event: "participant_joined", room: "r2" },
    ];
    assert.deepEqual(missingWebhookEvents(w, "r1", ["room_started", "participant_joined"]), [
      "participant_joined",
    ]);
  });
  test("selectRunRoom ignores production call- rooms and other runs; ambiguity is an error", () => {
    const p = smokeNames("cccccccccccc").roomPrefix;
    const other = smokeNames("dddddddddddd").roomPrefix;
    assert.equal(selectRunRoom(["call-abc", `${other}x`], p), null);
    assert.equal(selectRunRoom(["call-abc", `${p}x`, `${other}y`], p), `${p}x`);
    assert.throws(() => selectRunRoom([`${p}x`, `${p}y`], p), SmokeGuardError);
    assert.throws(() => selectRunRoom(["call-x"], "call-"), SmokeGuardError);
    assert.throws(() => selectRunRoom([], "smoke-call-"), SmokeGuardError);
  });
});

describe("smoke.ts wiring", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../deploy/local/smoke.ts"),
    "utf8",
  );
  test("never imports production names or provisioning, and deletes only through SmokeSipRun", () => {
    for (const bad of [
      "INBOUND_TRUNK_NAME",
      "DISPATCH_RULE_NAME",
      "OUTBOUND_TRUNK_NAME",
      "provisionSip",
      "ROOM_PREFIX",
      "sip-provisioning",
      "deleteSipTrunk",
      "deleteSipDispatchRule",
      "createSipInboundTrunk",
      "createSipDispatchRule",
    ])
      assert.ok(!src.includes(bad), `smoke.ts must not reference ${bad}`);
    for (const p of [INBOUND_TRUNK_NAME, OUTBOUND_TRUNK_NAME])
      assert.ok(!src.includes(p), `no literal ${p}`);
    // "clickai-receptionist" is also the default AGENT name (not a SIP object): only there.
    const uses = src.split("\n").filter((l) => l.includes(`"${DISPATCH_RULE_NAME}"`));
    assert.deepEqual(
      uses.map((l) => l.trim()),
      [`const AGENT = env["AGENT_NAME"] || "${DISPATCH_RULE_NAME}";`],
    );
  });
  test("refuses non-local targets at start-up and proves locality before creating SIP objects", () => {
    assert.match(
      src,
      /assertLocalTarget\(\{ url: HTTP, apiKey: KEY \}\)[\s\S]*?process\.exit\(2\)/,
    );
    const proof = src.indexOf("assertWebhookProof(webhooks, dispatchRoom)");
    const pre = src.indexOf("await preflight(sip, RUN)");
    const setup = src.indexOf("await r.setup(");
    assert.ok(proof > 0 && proof < pre && pre < setup);
    assert.match(src, /finally \{[\s\S]*?\.cleanup\(\)/);
  });
});
