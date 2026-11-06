import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { SipClient } from "livekit-server-sdk";
import {
  DISPATCH_RULE_NAME,
  INBOUND_TRUNK_NAME,
  OUTBOUND_TRUNK_NAME,
  ProvisionError,
  listSet,
  provisionSip,
  type DesiredSip,
} from "../deploy/livekit/sip-provisioning.ts";

/**
 * Phase 2.15. The REAL livekit-server-sdk 2.19.2 SipClient, with fetch
 * stubbed by an in-process model of LiveKit's SIP twirp service: request
 * bodies are exactly what the SDK sends; the model applies them to its
 * state (ListUpdate set/add/remove/clear for partial updates, whole-object
 * replace) and answers with protobuf JSON, so every apply is followed by a
 * real read-back. No network. LiveKit's own server is NOT exercised: the
 * model's semantics are this file's assumption, mirroring the protocol
 * definitions (livekit_sip.proto: ListUpdate, UpdateSIPInboundTrunkRequest,
 * UpdateSIPDispatchRuleRequest).
 */
type J = Record<string, unknown>;
interface Fake {
  inbound: J[];
  rules: J[];
  outbound: J[];
  calls: Array<{ method: string; body: J }>;
  fail: Record<string, { status: number; times: number }>;
  /** Simulates a server that accepts updates but does not apply them. */
  ignoreUpdates: boolean;
  /** Simulates an outbound trunk appearing as a side effect (verification must catch it). */
  sneakOutbound: boolean;
}
let fake: Fake;
const origFetch = globalThis.fetch;
let seq = 0;

function applyList(current: unknown, lu: J | undefined): string[] {
  let out = Array.isArray(current) ? [...(current as string[])] : [];
  if (!lu) return out;
  if (lu["clear"]) out = [];
  if (Array.isArray(lu["set"])) out = [...(lu["set"] as string[])];
  if (Array.isArray(lu["add"]))
    for (const x of lu["add"] as string[]) if (!out.includes(x)) out.push(x);
  if (Array.isArray(lu["remove"])) out = out.filter((x) => !(lu["remove"] as string[]).includes(x));
  return out;
}

function install() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = url.pathname.split("/").pop()!;
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as J;
    fake.calls.push({ method, body });
    const f = fake.fail[method];
    if (f && f.times > 0) {
      f.times--;
      return new Response(JSON.stringify({ code: "internal", msg: `injected ${method} failure` }), {
        status: f.status,
        headers: { "content-type": "application/json" },
      });
    }
    const ok = (x: unknown) =>
      new Response(JSON.stringify(x), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    switch (method) {
      case "ListSIPInboundTrunk":
        return ok({ items: fake.inbound });
      case "ListSIPDispatchRule":
        return ok({ items: fake.rules });
      case "ListSIPOutboundTrunk":
        return ok({ items: fake.outbound });
      case "CreateSIPInboundTrunk": {
        const t = { ...(body["trunk"] as J), sipTrunkId: `ST_in${++seq}` };
        fake.inbound.push(t);
        if (fake.sneakOutbound)
          fake.outbound.push({ name: "surprise", sipTrunkId: `ST_out${++seq}` });
        return ok(t);
      }
      case "UpdateSIPInboundTrunk": {
        const t = fake.inbound.find((x) => x["sipTrunkId"] === body["sipTrunkId"]);
        if (!t) return new Response('{"code":"not_found"}', { status: 404 });
        if (!fake.ignoreUpdates) {
          if (body["replace"]) Object.assign(t, body["replace"], { sipTrunkId: t["sipTrunkId"] });
          const u = body["update"] as J | undefined;
          if (u) {
            t["numbers"] = applyList(t["numbers"], u["numbers"] as J | undefined);
            t["allowedAddresses"] = applyList(
              t["allowedAddresses"],
              u["allowedAddresses"] as J | undefined,
            );
          }
        }
        return ok(t);
      }
      case "CreateSIPDispatchRule": {
        const r = { ...body, sipDispatchRuleId: `SDR_${++seq}` };
        fake.rules.push(r);
        return ok(r);
      }
      case "UpdateSIPDispatchRule": {
        const r = fake.rules.find((x) => x["sipDispatchRuleId"] === body["sipDispatchRuleId"]);
        if (!r) return new Response('{"code":"not_found"}', { status: 404 });
        if (!fake.ignoreUpdates) {
          if (body["replace"]) {
            for (const k of Object.keys(r)) if (k !== "sipDispatchRuleId") delete r[k];
            Object.assign(r, body["replace"], { sipDispatchRuleId: r["sipDispatchRuleId"] });
          }
          const u = body["update"] as J | undefined;
          if (u?.["trunkIds"]) r["trunkIds"] = applyList(r["trunkIds"], u["trunkIds"] as J);
        }
        return ok(r);
      }
      case "CreateSIPOutboundTrunk": {
        const t = { ...(body["trunk"] as J), sipTrunkId: `ST_out${++seq}` };
        fake.outbound.push(t);
        return ok(t);
      }
      default:
        return new Response('{"code":"not_found"}', { status: 404 });
    }
  }) as typeof fetch;
}

beforeEach(() => {
  fake = {
    inbound: [],
    rules: [],
    outbound: [],
    calls: [],
    fail: {},
    ignoreUpdates: false,
    sneakOutbound: false,
  };
  install();
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

const sip = () => new SipClient("http://127.0.0.1:7880", "APIkey", "secret-secret-secret-secret");
const DESIRED: DesiredSip = {
  inboundNumbers: ["+918000000001"],
  allowedAddresses: ["203.0.113.10", "203.0.113.11/32"],
  agentName: "clickai-receptionist",
  outbound: null,
};
const run = (d: Partial<DesiredSip> = {}, apply = true) =>
  provisionSip(sip(), { ...DESIRED, ...d }, { apply, appEnv: "staging" });
const mutating = () => fake.calls.filter((c) => !c.method.startsWith("List")).map((c) => c.method);
const bodyOf = (method: string) => fake.calls.filter((c) => c.method === method).at(-1)!.body;

describe("SIP provisioning: serialization (the Phase 2.14 defect)", () => {
  test("before: plain arrays serialize to an EMPTY update; after: ListUpdate set carries the values", async () => {
    fake.inbound.push({ name: INBOUND_TRUNK_NAME, sipTrunkId: "ST_x", numbers: ["+918000000001"] });
    const c = sip();
    // The pre-2.15 call shape:
    await c.updateSipInboundTrunkFields("ST_x", {
      numbers: ["+918000000002"],
      allowedAddresses: ["203.0.113.10"],
    } as never);
    assert.deepEqual(bodyOf("UpdateSIPInboundTrunk"), {
      sipTrunkId: "ST_x",
      update: { numbers: {}, allowedAddresses: {} },
    });
    // The corrected shape:
    await c.updateSipInboundTrunkFields("ST_x", {
      numbers: listSet(["+918000000002"]),
      allowedAddresses: listSet(["203.0.113.10"]),
    });
    assert.deepEqual(bodyOf("UpdateSIPInboundTrunk"), {
      sipTrunkId: "ST_x",
      update: { numbers: { set: ["+918000000002"] }, allowedAddresses: { set: ["203.0.113.10"] } },
    });
    // An empty list must be an explicit clear (proto3 JSON drops "set": []).
    await c.updateSipInboundTrunkFields("ST_x", { allowedAddresses: listSet([]) });
    assert.deepEqual(bodyOf("UpdateSIPInboundTrunk"), {
      sipTrunkId: "ST_x",
      update: { allowedAddresses: { clear: true } },
    });
  });
  test("dispatch rule: plain trunkIds array is empty on the wire; ListUpdate set is not", async () => {
    fake.rules.push({ name: DISPATCH_RULE_NAME, sipDispatchRuleId: "SDR_x" });
    const c = sip();
    await c.updateSipDispatchRuleFields("SDR_x", { trunkIds: ["ST_a"] } as never);
    assert.deepEqual(bodyOf("UpdateSIPDispatchRule"), {
      sipDispatchRuleId: "SDR_x",
      update: { trunkIds: {} },
    });
    await c.updateSipDispatchRuleFields("SDR_x", { trunkIds: listSet(["ST_a"]) });
    assert.deepEqual(bodyOf("UpdateSIPDispatchRule"), {
      sipDispatchRuleId: "SDR_x",
      update: { trunkIds: { set: ["ST_a"] } },
    });
  });
});

describe("SIP provisioning: plan, apply, read-back", () => {
  test("creating a trunk and a rule in an empty project; verified by read-back; no outbound trunk", async () => {
    const r = await run();
    assert.deepEqual(r.plan.inbound, "create");
    assert.deepEqual(r.applied, ["create inbound trunk", "create dispatch rule"]);
    assert.deepEqual(mutating(), ["CreateSIPInboundTrunk", "CreateSIPDispatchRule"]);
    const trunk = bodyOf("CreateSIPInboundTrunk")["trunk"] as J;
    assert.deepEqual(trunk["numbers"], ["+918000000001"]);
    assert.deepEqual(trunk["allowedAddresses"], ["203.0.113.10", "203.0.113.11/32"]);
    const rule = bodyOf("CreateSIPDispatchRule");
    assert.deepEqual(rule["rule"], { dispatchRuleIndividual: { roomPrefix: "call-" } });
    assert.deepEqual(rule["trunkIds"], [fake.inbound[0]!["sipTrunkId"]]);
    assert.deepEqual(rule["roomConfig"], { agents: [{ agentName: "clickai-receptionist" }] });
    assert.equal(fake.outbound.length, 0);
  });
  test("dry run: only lists, never creates or updates", async () => {
    const r = await run({}, false);
    assert.equal(r.plan.inbound, "create");
    assert.deepEqual(mutating(), []);
    fake.inbound.push({
      name: INBOUND_TRUNK_NAME,
      sipTrunkId: "ST_1",
      numbers: ["+918000000009"],
      allowedAddresses: [],
    });
    const r2 = await run({}, false);
    assert.equal(r2.plan.inbound, "update");
    assert.deepEqual(mutating(), []);
    assert.deepEqual(fake.inbound[0]!["numbers"], ["+918000000009"]);
  });
  test("repeated provisioning is idempotent: the second run changes nothing", async () => {
    await run();
    const n = fake.calls.length;
    const again = await run();
    assert.deepEqual(
      [again.plan.inbound, again.plan.rule, again.plan.outbound],
      ["unchanged", "unchanged", "skip"],
    );
    assert.deepEqual(again.applied, []);
    assert.deepEqual(
      fake.calls
        .slice(n)
        .map((c) => c.method)
        .filter((m) => !m.startsWith("List")),
      [],
    );
  });
  test("updating phone numbers on an existing trunk (number migration and rollback)", async () => {
    await run();
    await run({ inboundNumbers: ["+918000000001", "+918000000002"] });
    assert.deepEqual(bodyOf("UpdateSIPInboundTrunk")["update"], {
      numbers: { set: ["+918000000001", "+918000000002"] },
      allowedAddresses: { set: ["203.0.113.10", "203.0.113.11/32"] },
    });
    assert.deepEqual(fake.inbound[0]!["numbers"], ["+918000000001", "+918000000002"]);
    // Rollback of one number: remove it again.
    await run({ inboundNumbers: ["+918000000001"] });
    assert.deepEqual(fake.inbound[0]!["numbers"], ["+918000000001"]);
    assert.equal(fake.inbound.length, 1, "updated in place, never duplicated");
  });
  test("updating the signalling IP allow-list", async () => {
    await run();
    await run({ allowedAddresses: ["198.51.100.0/24"] });
    assert.deepEqual(fake.inbound[0]!["allowedAddresses"], ["198.51.100.0/24"]);
  });
  test("dispatch rule: wrong trunk -> partial update; wrong agent or room shape -> full replace keeping other fields", async () => {
    await run();
    const trunkId = fake.inbound[0]!["sipTrunkId"];
    fake.rules[0]!["trunkIds"] = ["ST_other"];
    await run();
    assert.deepEqual(bodyOf("UpdateSIPDispatchRule")["update"], { trunkIds: { set: [trunkId] } });
    assert.deepEqual(fake.rules[0]!["trunkIds"], [trunkId]);

    fake.rules[0]!["roomConfig"] = { agents: [{ agentName: "old-agent" }] };
    fake.rules[0]!["metadata"] = "keep-me";
    fake.rules[0]!["rule"] = { dispatchRuleDirect: { roomName: "lobby" } };
    await run();
    const replace = bodyOf("UpdateSIPDispatchRule")["replace"] as J;
    assert.deepEqual(replace["roomConfig"], { agents: [{ agentName: "clickai-receptionist" }] });
    assert.deepEqual(replace["rule"], { dispatchRuleIndividual: { roomPrefix: "call-" } });
    assert.equal(replace["metadata"], "keep-me", "fields not managed here are kept");
    assert.deepEqual(fake.rules[0]!["roomConfig"], {
      agents: [{ agentName: "clickai-receptionist" }],
    });
  });
  test("failed read-back verification: LiveKit accepted the update but the state does not match -> ProvisionError", async () => {
    await run();
    fake.ignoreUpdates = true;
    await assert.rejects(
      run({ inboundNumbers: ["+918000000002"] }),
      (e) =>
        e instanceof ProvisionError &&
        /verification failed after apply: inbound numbers are \[\+918000000001\], expected \[\+918000000002\]/.test(
          e.message,
        ) &&
        e.applied.includes("update inbound trunk"),
    );
  });
  test("API failure after a partial apply: reports what was applied; a re-run converges", async () => {
    fake.fail["CreateSIPDispatchRule"] = { status: 400, times: 1 };
    await assert.rejects(
      run(),
      (e) =>
        e instanceof ProvisionError &&
        /failed at "create dispatch rule"/.test(e.message) &&
        e.applied.join() === "create inbound trunk",
    );
    assert.equal(fake.inbound.length, 1);
    assert.equal(fake.rules.length, 0);
    const r = await run();
    assert.deepEqual(r.applied, ["create dispatch rule"]);
    assert.equal(fake.inbound.length, 1, "the trunk is not created twice");
  });
  test("API failure while reading (dry run or apply): nothing is changed", async () => {
    fake.fail["ListSIPDispatchRule"] = { status: 400, times: 2 };
    await assert.rejects(run({}, false));
    await assert.rejects(run());
    assert.deepEqual(mutating(), []);
  });
  test("ambiguous state (two trunks with the managed name) is refused before any change", async () => {
    fake.inbound.push(
      { name: INBOUND_TRUNK_NAME, sipTrunkId: "ST_a" },
      { name: INBOUND_TRUNK_NAME, sipTrunkId: "ST_b" },
    );
    await assert.rejects(
      run(),
      (e) => e instanceof ProvisionError && /ambiguous: 2 inbound trunks/.test(e.message),
    );
    assert.deepEqual(mutating(), []);
  });
});

describe("SIP provisioning: outbound is never created by accident", () => {
  test("without an explicit outbound request: no CreateSIPOutboundTrunk, even across repeated runs", async () => {
    await run();
    await run({ inboundNumbers: ["+918000000002"] });
    assert.ok(!mutating().includes("CreateSIPOutboundTrunk"));
    assert.equal(fake.outbound.length, 0);
  });
  test("an outbound trunk appearing as a side effect fails verification", async () => {
    fake.sneakOutbound = true;
    await assert.rejects(
      run(),
      (e) =>
        e instanceof ProvisionError &&
        /outbound trunk was created although outbound was not requested/.test(e.message),
    );
  });
  test("an existing outbound trunk is never updated or deleted when outbound is not requested", async () => {
    fake.outbound.push({
      name: OUTBOUND_TRUNK_NAME,
      sipTrunkId: "ST_o",
      address: "x.sip.vobiz.ai",
    });
    await run();
    assert.ok(!mutating().some((m) => m.includes("Outbound")));
    assert.equal(fake.outbound.length, 1);
  });
  test("explicitly requested: created once, then left alone; credentials are sent only to LiveKit", async () => {
    const outbound = { domain: "acme.sip.vobiz.ai", username: "u", password: "p" };
    const r = await run({ outbound });
    assert.ok(r.applied.includes("create outbound trunk"));
    await run({ outbound });
    assert.equal(fake.calls.filter((c) => c.method === "CreateSIPOutboundTrunk").length, 1);
  });
});

describe("SIP provisioning: input validation", () => {
  const bad: Array<[string, Partial<DesiredSip>, RegExp]> = [
    [
      "no numbers (a trunk without numbers could match any number)",
      { inboundNumbers: [] },
      /at least one number/,
    ],
    ["not E.164", { inboundNumbers: ["08000000001"] }, /not E\.164/],
    ["duplicates", { inboundNumbers: ["+918000000001", "+918000000001"] }, /duplicates/],
    ["bad IP", { allowedAddresses: ["vobiz.example"] }, /not an IPv4/],
    ["open allow-list outside development", { allowedAddresses: ["0.0.0.0/0"] }, /signalling IPs/],
    ["empty allow-list outside development", { allowedAddresses: [] }, /signalling IPs/],
    ["bad agent name", { agentName: "Agent!" }, /AGENT_NAME/],
  ];
  for (const [name, d, re] of bad)
    test(`refused before any request: ${name}`, async () => {
      await assert.rejects(run(d), (e) => e instanceof ProvisionError && re.test(e.message));
      assert.equal(fake.calls.length, 0);
    });
});
