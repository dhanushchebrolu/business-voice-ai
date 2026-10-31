import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * telephony-runtime.ts (routeToAgentRuntime/terminateAgentRuntime) had NO
 * test coverage before this file — the tenant/agent-loading boundary
 * between Phase D (telephony) and the AI runtime was entirely unverified.
 * This sandbox cannot reach a live Supabase instance (confirmed throughout
 * this repo's other tests — e.g. call-session-durable-object.server.test.ts's
 * own module doc), and no Supabase-mocking harness exists anywhere in this
 * codebase, so this follows the same established convention as
 * agent.functions.test.ts/sarvam-admin.functions.test.ts: a source scan
 * proving the tenant-isolation and agent-loading guarantees are actually
 * implemented the way they're claimed to be, not merely asserted by intent.
 *
 * Test case mapping (see the final report's 20-case table):
 *   #2  Correct tenant/agent loading
 *   #14 Invalid agent configuration
 *   #20 Cross-tenant access rejection
 */

const runtimeSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "telephony-runtime.ts"),
  "utf8",
);
const guardSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "telephony-guard.server.ts"),
  "utf8",
);

describe("Runtime lifecycle diagnostics (live-call regression: call_logs.status ended up 'failed' with no visible reason — the entitlement gate was rejecting the call, and nothing logged why)", () => {
  test("business resolution is logged with whether a business was found, never the business/organization id itself", () => {
    const logStart = runtimeSrc.indexOf('console.info("telephony:runtime_stage", {\n      callId');
    assert.ok(logStart > -1);
    const logEnd = runtimeSrc.indexOf("});", logStart);
    const block = runtimeSrc.slice(logStart, logEnd);
    assert.match(block, /stage: "business_resolution"/);
    assert.match(block, /resolved: Boolean\(businessId\)/);
    // The logged object itself never carries the id values, only booleans.
    assert.doesNotMatch(block, /organizationId:|businessId:/);
  });

  test("agent resolution is logged with its source (published version vs. live snapshot), never the agent name or instructions text", () => {
    const idx = runtimeSrc.indexOf('stage: "agent_resolution"');
    assert.ok(idx > -1);
    const block = runtimeSrc.slice(Math.max(0, idx - 100), idx + 200);
    assert.match(block, /source: publishedVersion \? "published_version" : "live_snapshot"/);
    assert.doesNotMatch(block, /businessName/);
  });

  test("the final media+runtime handoff result is logged for both the production (Durable Object) and local-dev fallback paths", () => {
    assert.match(runtimeSrc, /stage: "media_and_runtime_handoff"/);
    assert.match(runtimeSrc, /stage: "media_bridge_open"/);
  });
});

describe("Durable Object RPC diagnostics (production incident: media_and_runtime_handoff resolved false with no way to tell why)", () => {
  test("the DO RPC's HTTP status is logged unconditionally, not only on a non-2xx response", () => {
    const statusLogIdx = runtimeSrc.indexOf('console.info("telephony:runtime_do_rpc_status"');
    const okCheckIdx = runtimeSrc.indexOf("if (!response.ok)");
    assert.ok(statusLogIdx > -1 && okCheckIdx > -1);
    assert.ok(
      statusLogIdx < okCheckIdx,
      "the status must be logged before the ok/not-ok branch decides what to do with it",
    );
    const block = runtimeSrc.slice(statusLogIdx, okCheckIdx);
    assert.match(block, /httpStatus: response\.status/);
  });

  test("the DO's response note (the exact reason handled resolved false or true) is logged alongside the media_and_runtime_handoff result, not discarded", () => {
    const idx = runtimeSrc.indexOf('stage: "media_and_runtime_handoff"');
    assert.ok(idx > -1);
    const block = runtimeSrc.slice(idx, idx + 200);
    assert.match(block, /resolved: result\.handled/);
    assert.match(block, /note: result\.note/);
  });

  test("result.note is treated as a safe-to-log fixed string (like telephony-guard.server.ts's gate.reason), not redacted or dropped", () => {
    const idx = runtimeSrc.indexOf("note: result.note");
    const block = runtimeSrc.slice(Math.max(0, idx - 900), idx);
    assert.match(block, /safe to log verbatim/i);
  });
});

describe("#2 Correct tenant/agent loading — every ID routeToAgentRuntime uses is caller-supplied, never re-derived from anything else inside this function", () => {
  test("organizationId/businessId/phoneNumberId are read from the function's own input, not fetched by a separate, spoofable lookup", () => {
    assert.match(runtimeSrc, /export async function routeToAgentRuntime\(/);
    // The function signature takes these as input (AgentRuntimeHandoffInput) —
    // it re-verifies them, it does not re-derive them from a client-suppliable
    // source of truth.
    assert.match(runtimeSrc, /organizationId: string;/);
    assert.match(runtimeSrc, /phoneNumberId: string;/);
  });

  test("the authorization gate is re-derived using the caller's organizationId + phoneNumberId, via the one shared checkTelephonyAccess function — never a second, parallel check", () => {
    assert.match(
      runtimeSrc,
      /const gate = await checkTelephonyAccess\(input\.organizationId, input\.phoneNumberId, "inbound"\);/,
    );
    assert.match(runtimeSrc, /if \(!gate\.allowed\) \{\s*\n\s*return \{ handled: false/);
  });

  test("the agent snapshot/instructions are loaded for the resolved businessId, from either the published agent_versions row or a live snapshot — both scoped by business_id", () => {
    assert.match(
      runtimeSrc,
      /\.from\("agent_versions"\)\s*\n\s*\.select\("version, snapshot, instructions"\)\s*\n\s*\.eq\("business_id", businessId\)/,
    );
    assert.match(runtimeSrc, /await loadSnapshot\(supabaseAdmin, businessId\)/);
  });

  test("businessId itself is resolved FROM organizationId (via resolveBusinessId), never accepted as an independent, unrelated client value that could point at another org's business", () => {
    const fnStart = runtimeSrc.indexOf("async function resolveBusinessId(");
    const fnBody = runtimeSrc.slice(fnStart, runtimeSrc.indexOf("\n}\n", fnStart));
    assert.match(fnBody, /\.from\("businesses"\)/);
    assert.match(fnBody, /\.eq\("organization_id", organizationId\)/);
  });
});

describe("#20 Cross-tenant access rejection — the actual isolation mechanism", () => {
  test("checkTelephonyAccess's phone_numbers lookup is scoped by BOTH the number's id AND the caller's organization_id — a number belonging to a different org matches no row", () => {
    const fnStart = guardSrc.indexOf("export async function checkTelephonyAccess(");
    const fnBody = guardSrc.slice(fnStart, guardSrc.indexOf("\n}\n", fnStart));
    assert.match(
      fnBody,
      /\.from\("phone_numbers"\)\s*\n\s*\.select\("\*"\)\s*\n\s*\.eq\("id", phoneNumberId\)\s*\n\s*\.eq\("organization_id", orgId\)/,
    );
    // A missing row (the cross-tenant case) is rejected with a clear
    // reason, never treated as "allowed by default".
    assert.match(
      fnBody,
      /if \(!number\)\s*\n\s*return \{\s*\n\s*allowed: false,\s*\n\s*reason: "This phone number is not assigned to this organization\."/,
    );
  });

  test("routeToAgentRuntime never bypasses this check — it is called unconditionally before any agent/instructions work begins", () => {
    const checkIdx = runtimeSrc.indexOf("const gate = await checkTelephonyAccess(");
    const loadIdx = runtimeSrc.indexOf("const businessId = await resolveBusinessId(");
    assert.ok(checkIdx > -1 && loadIdx > -1);
    assert.ok(
      checkIdx < loadIdx,
      "the tenant/entitlement gate must run before any agent data is loaded",
    );
  });

  test("the media-session validation path independently re-derives organization_id from call_logs by provider_call_id, never trusts a client-supplied org id on the media socket", () => {
    // Both call-session-durable-object.server.ts and
    // exotel-media-route.server.ts delegate this lookup/gate to one shared
    // module (media-session-authorization.server.ts) rather than each
    // carrying their own copy — see that module's own doc for why (a prior
    // fix landed in only one of the two duplicated copies and never reached
    // production traffic).
    const doSrc = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "telephony",
        "call-session-durable-object.server.ts",
      ),
      "utf8",
    );
    assert.match(
      doSrc,
      /import \{ authorizeExotelMediaSession, maskCallSid \} from "\.\/media-session-authorization\.server\.ts";/,
    );

    const authSrc = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "telephony",
        "media-session-authorization.server.ts",
      ),
      "utf8",
    );
    // Generalized (Vobiz migration) to take a `provider` parameter so a
    // second provider with the same "connects to us as a WS client" media
    // shape reuses this exact function rather than carrying its own copy —
    // see that module's own doc. The lookup itself is still scoped by
    // provider (never a bare provider_call_id match across providers), and
    // the original Exotel entry point still passes "exotel" literally via
    // an unchanged, behavior-identical wrapper.
    assert.match(
      authSrc,
      /\.from\("call_logs"\)\s*\n\s*\.select\("id, organization_id, phone_number_id, status"\)\s*\n\s*\.eq\("provider", provider\)\s*\n\s*\.eq\("provider_call_id", callSid\)/,
    );
    assert.match(authSrc, /return authorizeMediaSession\("exotel", callSid, optionalToken\);/);
    assert.match(
      authSrc,
      /const gate = await checkTelephonyAccess\(call\.organization_id, phoneNumber\.id, "inbound"\);/,
    );
  });
});

describe("#14 Invalid agent configuration — handoff refuses to start rather than running an ungrounded agent", () => {
  test("when no published version exists, the live snapshot is validated with the same validateAgentConfig publish uses, and issues block the handoff", () => {
    const liveFallbackStart = runtimeSrc.indexOf("const issues = validateAgentConfig(snapshot);");
    assert.ok(liveFallbackStart > -1);
    const nearby = runtimeSrc.slice(liveFallbackStart, liveFallbackStart + 400);
    // The only statement allowed before the refusal is ending the call
    // (endUnservableCall) — the handoff still returns handled:false at once.
    assert.match(
      nearby,
      /if \(issues\.length\) \{\s*\n(?:\s*await endUnservableCall\([^;]*\);\s*\n)?\s*return \{\s*\n\s*handled: false,/,
    );
    assert.match(nearby, /Agent configuration incomplete/);
  });

  test("no business configured for the workspace also refuses to start, rather than running the agent with empty context", () => {
    assert.match(
      runtimeSrc,
      /if \(!businessId\) \{\s*\n(?:\s*await endUnservableCall\([^;]*\);\s*\n)?\s*return \{ handled: false, note: "No business is configured for this workspace yet\." \};/,
    );
  });
});

describe("terminateAgentRuntime never throws out into its caller", () => {
  test("the Durable Object RPC path and the direct in-process fallback are both wrapped so a coordinator failure can't break call termination", () => {
    const fnStart = runtimeSrc.indexOf("export async function terminateAgentRuntime(");
    const fnBody = runtimeSrc.slice(fnStart, runtimeSrc.indexOf("\n}\n", fnStart));
    assert.match(fnBody, /try \{/);
    assert.match(fnBody, /catch \(err\)/);
  });
});

describe("Caller ID reaches the voice runtime (trusted webhook `From`, never speech)", () => {
  const telephonyDir = join(dirname(fileURLToPath(import.meta.url)), "telephony");
  const exotelDoSrc = readFileSync(
    join(telephonyDir, "call-session-durable-object.server.ts"),
    "utf8",
  );
  const vobizDoSrc = readFileSync(
    join(telephonyDir, "vobiz-call-session-durable-object.server.ts"),
    "utf8",
  );
  const webhookSrc = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "routes",
      "api",
      "public",
      "webhooks",
      "telephony.ts",
    ),
    "utf8",
  );

  test("the Durable Object RPC body and the in-process fallback both carry callerE164 as callerNumber", () => {
    const rpcStart = runtimeSrc.indexOf("const rpcInput: StartRuntimeRpcInput = {");
    const rpcBlock = runtimeSrc.slice(rpcStart, runtimeSrc.indexOf("};", rpcStart));
    assert.match(rpcBlock, /callerNumber: input\.callerE164/);
    const fallbackStart = runtimeSrc.indexOf("const handle = await startRuntimeSession({");
    const fallbackBlock = runtimeSrc.slice(fallbackStart, runtimeSrc.indexOf("});", fallbackStart));
    assert.match(fallbackBlock, /callerNumber: input\.callerE164/);
  });

  test("both providers' Durable Objects hand the RPC's callerNumber to startRuntimeSession", () => {
    for (const src of [exotelDoSrc, vobizDoSrc]) {
      const start = src.indexOf("const handle = await startRuntimeSession({");
      const block = src.slice(start, src.indexOf("});", start));
      assert.match(block, /callerNumber: body\.callerNumber \?\? null/);
    }
  });

  test("the webhook passes the provider's own From (stored caller_number as fallback), never a transcript", () => {
    const occurrences = [...webhookSrc.matchAll(/callerE164: ([^,\n]+)/g)].map((m) => m[1]);
    assert.ok(occurrences.length >= 2);
    for (const expr of occurrences) assert.match(expr!, /^event\.fromE164/);
  });

  test("the business country and timezone are read live from the business row and reach the runtime on every path", () => {
    assert.match(runtimeSrc, /\.from\("businesses"\)\s*\.select\("country, timezone"\)/);
    const rpcStart = runtimeSrc.indexOf("const rpcInput: StartRuntimeRpcInput = {");
    const rpcBlock = runtimeSrc.slice(rpcStart, runtimeSrc.indexOf("};", rpcStart));
    assert.match(rpcBlock, /businessCountry,/);
    assert.match(rpcBlock, /businessTimezone,/);
    const fallbackStart = runtimeSrc.indexOf("const handle = await startRuntimeSession({");
    const fallbackBlock = runtimeSrc.slice(
      fallbackStart,
      runtimeSrc.indexOf("});\n", fallbackStart),
    );
    assert.match(fallbackBlock, /businessCountry,/);
    assert.match(fallbackBlock, /businessTimezone,/);
    for (const src of [exotelDoSrc, vobizDoSrc]) {
      const start = src.indexOf("const handle = await startRuntimeSession({");
      const block = src.slice(start, src.indexOf("});\n", start));
      assert.match(block, /businessCountry: body\.businessCountry \?\? null/);
      assert.match(block, /businessTimezone: body\.businessTimezone \?\? null/);
    }
  });

  test("Vobiz sessions end the PSTN call through Vobiz's hang-up API; Exotel (no documented API here) does not claim to", () => {
    const vobizStart = vobizDoSrc.indexOf("const handle = await startRuntimeSession({");
    const vobizBlock = vobizDoSrc.slice(vobizStart, vobizDoSrc.indexOf("});\n", vobizStart));
    assert.match(vobizBlock, /requestProviderHangup: async \(\) =>/);
    assert.match(vobizBlock, /adapter\.hangupCall\(body\.providerCallId\)/);
    const exotelStart = exotelDoSrc.indexOf("const handle = await startRuntimeSession({");
    assert.doesNotMatch(
      exotelDoSrc.slice(exotelStart, exotelDoSrc.indexOf("});\n", exotelStart)),
      /requestProviderHangup/,
    );
  });
});

describe("greeting latency: routing reads after the gate", () => {
  test("the published version, business country and live services are read concurrently, still after the tenant/entitlement gate", () => {
    const gateIdx = runtimeSrc.indexOf("const gate = await checkTelephonyAccess(");
    const allIdx = runtimeSrc.indexOf(
      "const [{ data: publishedVersion }, { data: businessRow }, servicesRes] = await Promise.all([",
    );
    assert.ok(gateIdx > -1 && allIdx > -1);
    assert.ok(gateIdx < allIdx, "no agent data is read before the gate");
    const block = runtimeSrc.slice(allIdx, runtimeSrc.indexOf("]);", allIdx));
    assert.match(block, /\.from\("agent_versions"\)/);
    assert.match(block, /\.from\("businesses"\)\s*\.select\("country, timezone"\)/);
    assert.match(block, /\.from\("services"\)[\s\S]*\.eq\("business_id", businessId\)/);
  });

  test("a failed price read never falls back silently: the runtime is told prices are unverified", () => {
    // A read error (or a rejected query) leaves liveServices null — never an
    // empty or published list presented as current.
    assert.match(runtimeSrc, /const liveServices = servicesRes\.error\s*\? null/);
    assert.match(runtimeSrc, /\.catch\(\(error: unknown\) => \(\{ data: null, error \}\)\)/);
    // Both start paths (Durable Object RPC and in-process) carry the flag.
    assert.equal(runtimeSrc.match(/pricesUnverified: liveServices === null,/g)?.length, 2);
    for (const file of [
      "call-session-durable-object.server.ts",
      "vobiz-call-session-durable-object.server.ts",
    ]) {
      const doSrc = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "telephony", file),
        "utf8",
      );
      assert.match(doSrc, /pricesUnverified: body\.pricesUnverified === true,/, file);
    }
  });
});

describe("a call the runtime can never serve is ended, not left connected in silence", () => {
  test("endUnservableCall hangs up through the provider's own hang-up API and reports it", async () => {
    const { endUnservableCall } = await import("./telephony/unservable-call.ts");
    const hungUp: string[] = [];
    const adapter = {
      hangupCall: async (id: string) => {
        hungUp.push(id);
        return "hung_up" as const;
      },
    };
    assert.equal(await endUnservableCall(adapter, "CA-1", "call-1", "no_business"), true);
    assert.deepEqual(hungUp, ["CA-1"]);
  });

  test("a provider without a hang-up API (Exotel) is left exactly as before", async () => {
    const { endUnservableCall } = await import("./telephony/unservable-call.ts");
    assert.equal(await endUnservableCall({}, "CA-2", "call-2", "no_business"), false);
    assert.equal(await endUnservableCall(null, "CA-2", "call-2", "no_business"), false);
  });

  test("a failed hang-up is logged and never thrown into the webhook", async () => {
    const { endUnservableCall } = await import("./telephony/unservable-call.ts");
    const adapter = {
      hangupCall: async () => {
        throw new Error("Vobiz unreachable");
      },
    };
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      assert.equal(
        await endUnservableCall(adapter, "CA-3", "call-3", "agent_config_incomplete"),
        false,
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(logged.length, 1);
  });

  test("both deterministic refusals end the call before returning handled:false — and the gate denial does not (the caller is hearing the denial message)", () => {
    const noBusiness = runtimeSrc.indexOf('"No business is configured for this workspace yet."');
    const incomplete = runtimeSrc.indexOf("Agent configuration incomplete:");
    const gateDenied = runtimeSrc.indexOf("if (!gate.allowed) {");
    assert.ok(noBusiness > 0 && incomplete > 0 && gateDenied > 0);
    assert.match(
      runtimeSrc.slice(noBusiness - 200, noBusiness),
      /endUnservableCall\(adapter, input\.providerCallId, input\.callId, "no_business"\)/,
    );
    assert.match(
      runtimeSrc.slice(incomplete - 300, incomplete),
      /endUnservableCall\([\s\S]*"agent_config_incomplete"/,
    );
    assert.doesNotMatch(runtimeSrc.slice(gateDenied, gateDenied + 200), /endUnservableCall/);
  });
});
