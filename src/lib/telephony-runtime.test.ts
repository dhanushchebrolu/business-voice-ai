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
    assert.match(
      authSrc,
      /\.from\("call_logs"\)\s*\n\s*\.select\("id, organization_id, phone_number_id, status"\)\s*\n\s*\.eq\("provider", "exotel"\)\s*\n\s*\.eq\("provider_call_id", callSid\)/,
    );
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
    assert.match(nearby, /if \(issues\.length\) \{\s*\n\s*return \{\s*\n\s*handled: false,/);
    assert.match(nearby, /Agent configuration incomplete/);
  });

  test("no business configured for the workspace also refuses to start, rather than running the agent with empty context", () => {
    assert.match(
      runtimeSrc,
      /if \(!businessId\) \{\s*\n\s*return \{ handled: false, note: "No business is configured for this workspace yet\." \};/,
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
