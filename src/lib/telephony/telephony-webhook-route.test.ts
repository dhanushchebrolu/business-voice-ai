import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the Sarvam migration's tenant-isolation and
 * billing-reuse requirements on routes/api/public/webhooks/telephony.ts.
 *
 * This is a createFileRoute-based route file, which this repo's Node-native
 * test runner cannot import directly (established convention — see e.g.
 * service-lock-message.test.ts, constant-time-equals.server.test.ts). The
 * behavioral pieces that don't need a live Supabase connection are already
 * unit-tested directly in webhook-correlation.server.test.ts and
 * sarvam-provider.server.test.ts; this suite statically verifies the route
 * file's own wiring — that it actually calls into that logic correctly, and
 * that the invariants requirement F/G depend on (never fabricate tenant
 * attribution, always reuse the existing billing pipeline unmodified) hold
 * in the source as written.
 */

const routeSrc = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "routes",
    "api",
    "public",
    "webhooks",
    "telephony.ts",
  ),
  "utf8",
);

describe("telephony webhook route — signature verification and idempotency (unchanged)", () => {
  test("verifies the webhook signature before anything from the payload is trusted", () => {
    const verifyIdx = routeSrc.indexOf("verifyWebhookSignature");
    const normalizeIdx = routeSrc.indexOf("normalizeWebhookEvent");
    assert.ok(verifyIdx > -1 && normalizeIdx > -1);
    assert.ok(
      verifyIdx < normalizeIdx,
      "signature must be verified before the event is normalized/trusted",
    );
  });

  test("dedupes via the existing webhook_events (provider, event_id) unique index before any side effect", () => {
    assert.match(routeSrc, /from\("webhook_events"\)\s*\.insert\(/);
    assert.match(routeSrc, /code.*===\s*"23505"/);
    assert.match(routeSrc, /"ok \(duplicate\)"/);
  });
});

describe("telephony webhook route — inbound tenant resolution (unchanged from pre-Sarvam)", () => {
  test("resolves the organization via the shared resolveActivePhoneNumberByDestination helper, keyed on the called number + active status (see telephony-guard.server.test.ts for that helper's own matching-rule coverage)", () => {
    assert.match(
      routeSrc,
      /const phoneNumber = await resolveActivePhoneNumberByDestination\(providerId, destinationNumber\);/,
    );
  });

  test("there is exactly one call_logs INSERT in the whole route, and it only fires on the inbound (not outbound) new-call path", () => {
    const inserts = [...routeSrc.matchAll(/from\("call_logs"\)\s*\.insert\(/g)];
    assert.equal(
      inserts.length,
      1,
      "outbound events must never INSERT a call_logs row from webhook data alone",
    );
  });

  test("the inbound insert persists organization_id from the resolved phone_numbers row, never from the event payload", () => {
    assert.match(routeSrc, /organization_id:\s*phoneNumber\.organization_id/);
    assert.doesNotMatch(routeSrc, /organization_id:\s*event\./);
  });

  test("persists transcript, duration and ended_at on the inbound insert (Sarvam's one-shot terminal webhook)", () => {
    assert.match(routeSrc, /ended_at:\s*isTerminal \? event\.occurredAt : null/);
    assert.match(routeSrc, /duration_seconds:\s*event\.durationSeconds \?\? 0/);
    assert.match(routeSrc, /transcript:\s*event\.transcript/);
    assert.match(routeSrc, /provider_metadata:\s*buildProviderMetadata\(event\)/);
  });
});

describe("telephony webhook route — outbound tenant correlation (Sarvam addition)", () => {
  test("imports the correlation helpers from webhook-correlation.server, not ad hoc logic", () => {
    assert.match(
      routeSrc,
      /import\s*\{\s*buildProviderMetadata,\s*\n?\s*isPlausibleClientReference,?\s*\}\s*from\s*"@\/lib\/telephony\/webhook-correlation\.server"/,
    );
  });

  test("an outbound event with no existing call_logs row is resolved ONLY via a validated clientReference, never via phone number or any other field", () => {
    const outboundBranch = routeSrc.slice(
      routeSrc.indexOf('if (event.direction === "outbound") {'),
      routeSrc.indexOf("const destinationNumber ="),
    );
    assert.match(outboundBranch, /isPlausibleClientReference\(event\.clientReference\)/);
    assert.match(
      outboundBranch,
      /resolveOutboundCallByClientReference\(providerId, event\.clientReference\)/,
    );
    // Never falls back to attributing by phone number/caller id for outbound.
    assert.doesNotMatch(
      outboundBranch,
      /fromE164|toE164|destinationE164|user_phone_number|caller/i,
    );
  });

  test("an unresolved outbound event is dropped (logged, no row created/updated), never guessed", () => {
    const outboundBranch = routeSrc.slice(
      routeSrc.indexOf('if (event.direction === "outbound") {'),
      routeSrc.indexOf("const destinationNumber ="),
    );
    assert.match(outboundBranch, /if \(!resolved\) \{/);
    assert.match(outboundBranch, /telephony:webhook_unknown_outbound_call/);
  });

  test("resolveOutboundCallByClientReference only ever looks up a row Klyro already owns (by id, provider, direction) — it cannot invent one", () => {
    const fnSrc = routeSrc.slice(
      routeSrc.indexOf("async function resolveOutboundCallByClientReference"),
      routeSrc.indexOf("async function applyCallEvent"),
    );
    assert.doesNotMatch(fnSrc, /\.insert\(/);
    assert.match(fnSrc, /\.eq\("id", clientReference\)/);
    assert.match(fnSrc, /\.eq\("provider", providerId\)/);
    assert.match(fnSrc, /\.eq\("direction", "outbound"\)/);
  });
});

describe("telephony webhook route — reassignment safety (Phase 5 §8)", () => {
  test("the inbound phone_numbers lookup is scoped by provider, not just e164+active (delegated to resolveActivePhoneNumberByDestination, which takes providerId as its first argument)", () => {
    assert.match(
      routeSrc,
      /resolveActivePhoneNumberByDestination\(providerId, destinationNumber\)/,
    );
  });

  test("a mismatched event.providerDeploymentId vs phoneNumber.provider_deployment_id is dropped before checkTelephonyAccess/call_logs insert are ever reached", () => {
    const lookupIdx = routeSrc.indexOf("resolveActivePhoneNumberByDestination(providerId");
    const mismatchIdx = routeSrc.indexOf("telephony:webhook_stale_deployment_mismatch");
    const gateIdx = routeSrc.indexOf("checkTelephonyAccess(phoneNumber.organization_id");
    const insertIdx = routeSrc.indexOf('.from("call_logs")\n    .insert(');
    assert.ok(lookupIdx > -1 && mismatchIdx > -1 && gateIdx > -1 && insertIdx > -1);
    assert.ok(lookupIdx < mismatchIdx && mismatchIdx < gateIdx && gateIdx < insertIdx);
  });

  test("the mismatch check compares Klyro's own on-file mapping, never trusts the event alone, and requires both sides present before blocking", () => {
    const idx = routeSrc.indexOf("telephony:webhook_stale_deployment_mismatch");
    const block = routeSrc.slice(Math.max(0, idx - 500), idx);
    assert.match(block, /event\.providerDeploymentId\s*&&/);
    assert.match(block, /phoneNumber\.provider_deployment_id\s*&&/);
    assert.match(block, /event\.providerDeploymentId\s*!==\s*phoneNumber\.provider_deployment_id/);
  });

  test("does not attempt to attribute a mismatched event to any organization other than the currently-active one — it only ever returns (drops), never a second lookup/insert", () => {
    const startIdx = routeSrc.indexOf("telephony:webhook_stale_deployment_mismatch");
    const blockEnd = routeSrc.indexOf("const gate = await checkTelephonyAccess", startIdx);
    const block = routeSrc.slice(startIdx, blockEnd);
    assert.doesNotMatch(block, /\.insert\(/);
    assert.doesNotMatch(block, /\.from\("phone_numbers"\)/);
    assert.match(block, /return;/);
  });
});

describe("telephony webhook route — GET support (live-call regression: Exotel's Voicebot Passthru sends GET with fields in the query string, not POST)", () => {
  test("both GET and POST are registered, routed to the same shared handler — not POST-only", () => {
    assert.match(routeSrc, /GET:\s*\(\{\s*request\s*\}\)\s*=>\s*handleTelephonyWebhook\(request\)/);
    assert.match(
      routeSrc,
      /POST:\s*\(\{\s*request\s*\}\)\s*=>\s*handleTelephonyWebhook\(request\)/,
    );
  });

  test("a GET request's fields come from the URL query string, a POST's from the body — never the reverse", () => {
    assert.match(
      routeSrc,
      /const raw = request\.method === "GET" \? url\.search\.replace\(\/\^\\\?\/, ""\) : await request\.text\(\);/,
    );
  });

  test("verifyWebhookSignature/normalizeWebhookEvent are called on the shared `raw`, regardless of method — no separate GET-only code path bypasses either check", () => {
    const fnSrc = routeSrc.slice(
      routeSrc.indexOf("async function handleTelephonyWebhook"),
      routeSrc.indexOf("async function processTelephonyEvent"),
    );
    const rawIdx = fnSrc.indexOf("const raw =");
    const verifyIdx = fnSrc.indexOf("adapter.verifyWebhookSignature(raw");
    const normalizeIdx = fnSrc.indexOf("adapter.normalizeWebhookEvent(raw");
    assert.ok(rawIdx > -1 && verifyIdx > -1 && normalizeIdx > -1);
    assert.ok(rawIdx < verifyIdx && verifyIdx < normalizeIdx);
  });
});

describe("telephony webhook route — duplicate/racing inbound callbacks never create a second call_logs row (live-call regression)", () => {
  test("a concurrent duplicate insert (23505 on idx_call_logs_provider_call_id) falls back to the same update path as a pre-existing row, never throws past it", () => {
    const insertIdx = routeSrc.indexOf('.from("call_logs")\n    .insert(');
    assert.ok(insertIdx > -1);
    const nearby = routeSrc.slice(insertIdx, insertIdx + 2200);
    assert.match(nearby, /if \(insertError\) \{/);
    assert.match(nearby, /\(insertError as \{ code\?: string \}\)\.code === "23505"/);
    assert.match(nearby, /\.eq\("provider", providerId\)/);
    assert.match(nearby, /\.eq\("provider_call_id", event\.providerCallId\)/);
    assert.match(nearby, /await applyCallEvent\(existingRow, event\);/);
  });

  test("both the insert path and the applyCallEvent update path log a success event carrying provider_call_id and call_id (never a raw payload/secret)", () => {
    assert.match(routeSrc, /"telephony:call_log_inserted"/);
    assert.match(routeSrc, /"telephony:call_log_updated"/);
    assert.match(routeSrc, /"telephony:call_log_insert_raced"/);
  });
});

describe("telephony webhook route — unknown-number diagnostic (live-call regression: distinguishes missing/wrong-provider/inactive without a manual SQL query)", () => {
  test("an unmatched inbound number runs a second, broader (no provider/status filter) lookup and logs provider_call, normalized_number, and matching_rows_for_number — never organization_id or any other identifying field", () => {
    const idx = routeSrc.indexOf('console.error("telephony:webhook_unknown_number"');
    assert.ok(idx > -1);
    const block = routeSrc.slice(Math.max(0, idx - 1200), idx + 250);
    assert.match(block, /\.select\("provider, status"\)/);
    assert.match(block, /\.eq\("e164", destinationNumber\)/);
    assert.doesNotMatch(block, /organization_id/);
  });

  test("also logs only the Supabase project HOSTNAME (never the full URL, a key, or a secret) — distinguishes 'row genuinely missing' from 'Worker pointed at a different Supabase project'", () => {
    const supabaseUrlIdx = routeSrc.indexOf('process.env["SUPABASE_URL"]');
    const logIdx = routeSrc.indexOf('console.error("telephony:webhook_unknown_number"');
    assert.ok(supabaseUrlIdx > -1 && logIdx > -1);
    assert.ok(
      supabaseUrlIdx < logIdx,
      "the host must be resolved before the log call that uses it",
    );
    const block = routeSrc.slice(supabaseUrlIdx, logIdx + 400);
    assert.match(block, /new URL\(rawUrl\)\.hostname/);
    assert.match(block, /supabase_host: supabaseHost/);
    // Never the service-role key or the full connection string.
    assert.doesNotMatch(block, /SERVICE_ROLE_KEY/);
  });
});

describe("telephony webhook route — gate-rejection diagnostic (live-call regression: a call with a valid CallSid/status/phone-number match still ended up call_logs.status='failed' with no visible reason — checkTelephonyAccess was rejecting it, silently, before this log existed)", () => {
  test("when checkTelephonyAccess rejects an inbound call, the exact stage and reason are logged BEFORE the call_logs insert forces status to 'failed'", () => {
    const gateIdx = routeSrc.indexOf(
      'const gate = await checkTelephonyAccess(phoneNumber.organization_id, phoneNumber.id, "inbound");',
    );
    const logIdx = routeSrc.indexOf('console.error("telephony:call_rejected_by_gate"');
    const insertIdx = routeSrc.indexOf('.from("call_logs")\n    .insert(');
    assert.ok(gateIdx > -1 && logIdx > -1 && insertIdx > -1);
    assert.ok(
      gateIdx < logIdx && logIdx < insertIdx,
      "the rejection must be logged after the gate resolves but before the insert that turns it into status='failed'",
    );
    const block = routeSrc.slice(logIdx, logIdx + 400);
    assert.match(block, /stage: "entitlement_gate"/);
    assert.match(block, /reason: gate\.reason/);
  });

  test("checkTelephonyAccess is imported from the shared guard module, not reimplemented locally — gate.reason is always one of that module's own fixed strings, safe to log verbatim", () => {
    assert.match(
      routeSrc,
      /import\s*\{[\s\S]*?checkTelephonyAccess[\s\S]*?\}\s*from\s*"@\/lib\/telephony-guard\.server"/,
    );
  });
});

describe("telephony webhook route — billing/entitlement reuse (requirement E: do not rewrite)", () => {
  test("still imports and calls the exact existing telephony-guard.server functions, not a parallel implementation", () => {
    assert.match(
      routeSrc,
      /import\s*\{\s*\n?\s*checkCallTransition,\s*\n?\s*checkTelephonyAccess,\s*\n?\s*finalizeCallBilling,\s*\n?\s*maskPhoneNumber,\s*\n?\s*resolveActivePhoneNumberByDestination,\s*\n?\s*TERMINAL_CALL_STATUSES,?\s*\n?\s*\}\s*from\s*"@\/lib\/telephony-guard\.server"/,
    );
    assert.match(routeSrc, /checkTelephonyAccess\(/);
    assert.match(routeSrc, /checkCallTransition\(/);
    assert.match(routeSrc, /finalizeCallBilling\(/);
    assert.match(routeSrc, /resolveActivePhoneNumberByDestination\(/);
  });

  test("finalizeCallBilling is only ever invoked once a status is confirmed terminal via the shared TERMINAL_CALL_STATUSES list", () => {
    const occurrences = [...routeSrc.matchAll(/finalizeCallBilling\(/g)];
    assert.equal(
      occurrences.length,
      2,
      "expected exactly the two existing call sites (new-call and patch paths)",
    );
  });
});

/**
 * Extracts the exact runtime-handoff trigger condition's source (the
 * `const isAnswered = ...` through `const newCallTriggerMatched = ...;`
 * block right after the inbound new-call INSERT, before
 * `runInBackground(routeToAgentRuntime(...))`) and turns it into a real,
 * callable predicate built from that literal text via `new Function` — so
 * the regression tests below execute the ACTUAL route source, not a
 * reimplementation that could independently drift from or misrepresent it.
 */
function extractRuntimeHandoffTrigger(): (
  event: { status: string },
  providerId: string,
) => boolean {
  const blockStart = routeSrc.indexOf('const isAnswered = event.status === "answered";');
  assert.ok(blockStart > -1, "expected to find the new-call-insert trigger block");
  const blockEndMarker =
    "isAnswered || isInProgress || isExotelInitiated || isVobizRinging || isVobizInitiated;";
  const blockEnd = routeSrc.indexOf(blockEndMarker, blockStart);
  assert.ok(blockEnd > -1, "expected to find the end of the new-call-insert trigger block");
  const blockSrc = routeSrc.slice(blockStart, blockEnd + blockEndMarker.length);
  return new Function("event", "providerId", `${blockSrc}\n  return newCallTriggerMatched;`) as (
    event: { status: string },
    providerId: string,
  ) => boolean;
}

/**
 * Same extraction technique as extractRuntimeHandoffTrigger, for
 * applyCallEvent's OWN, separate runtime-handoff trigger (the "existing
 * call" path — reached when a call_logs row for this provider_call_id
 * already exists, e.g. a second/duplicate webhook delivery). Executes the
 * real source, not a reimplementation.
 */
function extractApplyCallEventTrigger(): (
  event: { status: string },
  call: { provider: string; direction: string; phone_number_id: string | null },
) => boolean {
  const blockStart = routeSrc.indexOf('const isApplyAnswered = event.status === "answered";');
  assert.ok(blockStart > -1, "expected to find the applyCallEvent trigger block");
  const blockEndMarker =
    "(isApplyAnswered || isApplyInProgress || isApplyVobizRinging || isApplyVobizInitiated);";
  const blockEnd = routeSrc.indexOf(blockEndMarker, blockStart);
  assert.ok(blockEnd > -1, "expected to find the end of the applyCallEvent trigger block");
  const blockSrc = routeSrc.slice(blockStart, blockEnd + blockEndMarker.length);
  return new Function("event", "call", `${blockSrc}\n  return applyTriggerMatched;`) as (
    event: { status: string },
    call: { provider: string; direction: string; phone_number_id: string | null },
  ) => boolean;
}

describe("telephony webhook route — Exotel/Vobiz runtime handoff on the first webhook event (production incidents: media session accepted, but the caller never heard Klyro's greeting / inbound audio dropped with no listener)", () => {
  test("the new-call insert path routes to the agent runtime on Exotel's 'initiated' and Vobiz's 'ringing'/'initiated', but not unconditionally for every provider", () => {
    const idx = routeSrc.indexOf("if (!gate.allowed) return;");
    const insertBranch = routeSrc.slice(idx, routeSrc.indexOf("routeToAgentRuntime({", idx));
    assert.match(insertBranch, /event\.status === "answered"/);
    assert.match(insertBranch, /event\.status === "in_progress"/);
    assert.match(
      insertBranch,
      /const isExotelInitiated = providerId === "exotel" && event\.status === "initiated";/,
      "expected Exotel's own clause, scoped to 'initiated' only, untouched",
    );
    assert.match(
      insertBranch,
      /const isVobizRinging = providerId === "vobiz" && event\.status === "ringing";/,
      "expected Vobiz's clause to cover 'ringing' (the confirmed real first-event status)",
    );
    assert.match(
      insertBranch,
      /const isVobizInitiated = providerId === "vobiz" && event\.status === "initiated";/,
      "expected Vobiz's clause to also cover 'initiated' (defensive fallback)",
    );
  });

  test("the widened trigger is still gated by gate.allowed (entitlement) exactly like the pre-existing 'answered'/'in_progress' trigger — it does not bypass the gate", () => {
    const gateIdx = routeSrc.indexOf("if (!gate.allowed) return;");
    const triggerIdx = routeSrc.indexOf('providerId === "vobiz" && event.status === "ringing"');
    assert.ok(gateIdx > -1 && triggerIdx > -1);
    assert.ok(
      gateIdx < triggerIdx,
      "the entitlement-gate short-circuit must run before the widened runtime-handoff trigger",
    );
  });

  test("does not widen the trigger onto the outbound path — only the inbound new-call insert and existing-row (applyCallEvent) branches", () => {
    const outboundBranch = routeSrc.slice(
      routeSrc.indexOf('if (event.direction === "outbound") {'),
      routeSrc.indexOf("const destinationNumber ="),
    );
    assert.doesNotMatch(outboundBranch, /event\.status === "initiated"/);
    assert.doesNotMatch(outboundBranch, /event\.status === "ringing"/);
  });

  test("getVobizCallSessionStub/routeToAgentRuntime are already fully Vobiz-aware downstream of this trigger — this change only widens WHEN the call fires, not the (already-correct, already-shipped) routing logic itself", () => {
    // Scoped to this file's own route source: telephony-runtime.ts's own
    // Vobiz-awareness is covered by telephony-runtime.test.ts.
    assert.match(routeSrc, /import \{ routeToAgentRuntime, terminateAgentRuntime \} from/);
  });

  describe("REGRESSION (production incidents dc249661-d3d2-48f3-9391-243017527b26 / 328a707b): executes the real extracted trigger condition against each confirmed/possible scenario", () => {
    const trigger = extractRuntimeHandoffTrigger();

    test("Vobiz + 'ringing' -> true (the confirmed real production status for call 328a707b; call_log_inserted logged status=ringing, not initiated)", () => {
      assert.equal(trigger({ status: "ringing" }, "vobiz"), true);
    });

    test("Vobiz + 'initiated' -> true (kept as a defensive fallback for a Vobiz callback variant that doesn't carry a recognized CallStatus)", () => {
      assert.equal(trigger({ status: "initiated" }, "vobiz"), true);
    });

    test("Exotel + 'initiated' -> true (existing, already-shipped behavior — unchanged by this fix)", () => {
      assert.equal(trigger({ status: "initiated" }, "exotel"), true);
    });

    test("Exotel + 'ringing' -> false (Exotel's own clause was never widened to 'ringing' — only Vobiz's was, based on Vobiz-specific production evidence)", () => {
      assert.equal(trigger({ status: "ringing" }, "exotel"), false);
    });

    test("other providers (e.g. sarvam) + 'ringing' -> false (no unintended runtime start for a provider never shown to need this widening)", () => {
      assert.equal(trigger({ status: "ringing" }, "sarvam"), false);
    });

    test("other providers (e.g. sarvam) + 'initiated' -> false (the pre-existing, intentional scoping — unaffected by this fix)", () => {
      assert.equal(trigger({ status: "initiated" }, "sarvam"), false);
    });

    test("any provider + 'answered'/'in_progress' -> true regardless of providerId (the original, provider-neutral trigger is untouched)", () => {
      assert.equal(trigger({ status: "answered" }, "some-future-provider"), true);
      assert.equal(trigger({ status: "in_progress" }, "some-future-provider"), true);
    });

    test("Vobiz + an unrelated status (e.g. 'completed') -> false (the widening is scoped to ringing/initiated only, not a blanket allow for Vobiz)", () => {
      assert.equal(trigger({ status: "completed" }, "vobiz"), false);
      assert.equal(trigger({ status: "failed" }, "vobiz"), false);
    });
  });

  describe("REGRESSION (production incident, call 03da4fdb): applyCallEvent's OWN, separate runtime-handoff trigger — reached whenever a call_logs row for this provider_call_id already exists (a second/duplicate webhook delivery, or a race lost against another in-flight insert) — had never been widened by any of the three insert-branch fixes above, and could never fire for a Vobiz call at ringing/initiated regardless of how correct the insert branch was", () => {
    const applyTrigger = extractApplyCallEventTrigger();
    const inboundCall = (provider: string, phoneNumberId: string | null = "pn-1") => ({
      provider,
      direction: "inbound",
      phone_number_id: phoneNumberId,
    });

    test("Vobiz + 'ringing' -> true (previously false — the exact gap this fix closes)", () => {
      assert.equal(applyTrigger({ status: "ringing" }, inboundCall("vobiz")), true);
    });

    test("Vobiz + 'initiated' -> true (previously false)", () => {
      assert.equal(applyTrigger({ status: "initiated" }, inboundCall("vobiz")), true);
    });

    test("Exotel + 'initiated' -> false (this trigger was never widened for Exotel — its own fast path is the insert-branch clause; unchanged by this fix)", () => {
      assert.equal(applyTrigger({ status: "initiated" }, inboundCall("exotel")), false);
    });

    test("Exotel + 'ringing' -> false (same reasoning)", () => {
      assert.equal(applyTrigger({ status: "ringing" }, inboundCall("exotel")), false);
    });

    test("other providers + 'ringing'/'initiated' -> false (no unintended runtime start)", () => {
      assert.equal(applyTrigger({ status: "ringing" }, inboundCall("sarvam")), false);
      assert.equal(applyTrigger({ status: "initiated" }, inboundCall("sarvam")), false);
    });

    test("any provider + 'answered'/'in_progress' -> true (the original, pre-existing, provider-neutral trigger is untouched)", () => {
      assert.equal(applyTrigger({ status: "answered" }, inboundCall("some-future-provider")), true);
      assert.equal(
        applyTrigger({ status: "in_progress" }, inboundCall("some-future-provider")),
        true,
      );
    });

    test("Vobiz + ringing on an OUTBOUND call -> false (the direction check is untouched)", () => {
      assert.equal(
        applyTrigger(
          { status: "ringing" },
          { provider: "vobiz", direction: "outbound", phone_number_id: "pn-1" },
        ),
        false,
      );
    });

    test("Vobiz + ringing with no phone_number_id -> false (the null-guard is untouched)", () => {
      assert.equal(applyTrigger({ status: "ringing" }, inboundCall("vobiz", null)), false);
    });

    test("Vobiz + an unrelated status (e.g. 'completed') -> false", () => {
      assert.equal(applyTrigger({ status: "completed" }, inboundCall("vobiz")), false);
    });
  });
});

describe("telephony webhook route — runtime-handoff diagnostics (production incident: routeToAgentRuntime's own first log line never appeared in any of 4 production test calls, proving it was never invoked from either call site — these diagnostics make the exact branch/condition/outcome observable from logs alone)", () => {
  test("logs providerId/status/direction/providerCallId the moment processTelephonyEvent receives an event, before any branch decision", () => {
    const idx = routeSrc.indexOf('console.info("telephony:process_event_received"');
    assert.ok(idx > -1);
    const existingCallIdx = routeSrc.indexOf("existingCall", idx);
    assert.ok(existingCallIdx > idx, "expected this log before the existingCall lookup");
  });

  test("logs which branch (new_call_insert vs existing_call_apply_event) processTelephonyEvent takes, right at the isNewCall decision point", () => {
    const idx = routeSrc.indexOf('console.info("telephony:process_event_branch"');
    assert.ok(idx > -1);
    const block = routeSrc.slice(idx, routeSrc.indexOf("});", idx));
    assert.match(block, /existingCallFound: Boolean\(existingCall\)/);
    assert.match(block, /branch: existingCall \? "existing_call_apply_event" : "new_call_insert"/);
    const ifExistingIdx = routeSrc.indexOf("if (existingCall) {", idx);
    assert.ok(ifExistingIdx > idx, "expected this log before the existingCall branch itself");
  });

  test("both trigger sites log telephony:runtime_trigger_evaluated unconditionally (regardless of outcome), tagged with a distinct 'site' field", () => {
    const occurrences = [
      ...routeSrc.matchAll(/console\.info\("telephony:runtime_trigger_evaluated"/g),
    ];
    assert.equal(occurrences.length, 2, "expected exactly one at each of the two trigger sites");
    assert.match(routeSrc, /site: "new_call_insert"/);
    assert.match(routeSrc, /site: "existing_call_apply_event"/);
  });

  test("both trigger sites log telephony:runtime_trigger_matched and telephony:runtime_handoff_start only inside their own if-block, never unconditionally", () => {
    const matchedOccurrences = [
      ...routeSrc.matchAll(/console\.info\("telephony:runtime_trigger_matched"/g),
    ];
    const handoffStartOccurrences = [
      ...routeSrc.matchAll(/console\.info\("telephony:runtime_handoff_start"/g),
    ];
    assert.equal(matchedOccurrences.length, 2);
    assert.equal(handoffStartOccurrences.length, 2);
  });

  test("applyCallEvent logs its own transition check (fromStatus/toStatus/transitionOk/transitionChanged) before either of its two early returns — both are silent with respect to the runtime trigger otherwise", () => {
    const transitionIdx = routeSrc.indexOf(
      "const transition = checkCallTransition(call.status, event.status);",
    );
    const logIdx = routeSrc.indexOf(
      'console.info("telephony:apply_call_event_transition"',
      transitionIdx,
    );
    const illegalReturnIdx = routeSrc.indexOf("if (!transition.ok) {", transitionIdx);
    const idempotentReturnIdx = routeSrc.indexOf("if (!transition.changed) return;", transitionIdx);
    assert.ok(
      transitionIdx > -1 && logIdx > -1 && illegalReturnIdx > -1 && idempotentReturnIdx > -1,
    );
    assert.ok(
      transitionIdx < logIdx && logIdx < illegalReturnIdx && illegalReturnIdx < idempotentReturnIdx,
      "the diagnostic must log before either early return, so both are observable from logs even though they remain silent with respect to the runtime trigger",
    );
  });

  test("none of the new diagnostics log a secret, auth token, webhook signature, or raw payload", () => {
    const diagnosticEventNames = [
      "telephony:process_event_received",
      "telephony:process_event_branch",
      "telephony:runtime_trigger_evaluated",
      "telephony:runtime_trigger_matched",
      "telephony:runtime_handoff_start",
      "telephony:apply_call_event_transition",
    ];
    for (const eventName of diagnosticEventNames) {
      const idx = routeSrc.indexOf(`console.info("${eventName}"`);
      assert.ok(idx > -1, `expected to find ${eventName}`);
      const block = routeSrc.slice(idx, routeSrc.indexOf("});", idx));
      assert.doesNotMatch(block, /\bheaders\b/);
      assert.doesNotMatch(block, /authToken/i);
      assert.doesNotMatch(block, /signature/i);
      assert.doesNotMatch(block, /\braw\b/);
      assert.doesNotMatch(block, /verify_token/i);
    }
  });
});

describe("telephony webhook route — Exotel/Vobiz Passthru/Voicebot deadlock fix (production incident: media session accepted... no — call goes silent and hangs up within a few seconds, before any WebSocket ever arrives)", () => {
  test("the runtime-handoff call is backgrounded (runInBackground), never awaited directly — awaiting it here re-creates the exact deadlock this fix resolves", () => {
    const idx = routeSrc.indexOf("if (!gate.allowed) return;");
    const triggerIdx = routeSrc.indexOf(
      'providerId === "vobiz" && event.status === "ringing"',
      idx,
    );
    assert.ok(triggerIdx > -1);
    const callSite = routeSrc.slice(
      triggerIdx,
      routeSrc.indexOf("providerCallId: event.providerCallId,\n      }),", triggerIdx),
    );
    assert.match(callSite, /runInBackground\(\s*routeToAgentRuntime\(/);
    assert.doesNotMatch(
      callSite,
      /await routeToAgentRuntime\(/,
      "must not synchronously await routeToAgentRuntime here — the media WebSocket this call waits on only opens AFTER this webhook responds, so awaiting it deadlocks the response",
    );
  });

  test("handleTelephonyWebhook reads waitUntil off the request and threads it into processTelephonyEvent, so runInBackground can register the handoff with Cloudflare's ExecutionContext", () => {
    assert.match(
      routeSrc,
      /import\s*\{\s*getRequestWaitUntil,\s*runInBackground,\s*type WaitUntil\s*\}\s*from\s*["']@\/lib\/background-task\.server["']/,
    );
    const handlerIdx = routeSrc.indexOf("async function handleTelephonyWebhook");
    const handlerSrc = routeSrc.slice(
      handlerIdx,
      routeSrc.indexOf("async function processTelephonyEvent"),
    );
    assert.match(handlerSrc, /const waitUntil = getRequestWaitUntil\(request\);/);
    assert.match(handlerSrc, /processTelephonyEvent\(providerId, event, waitUntil\)/);
  });

  test("processTelephonyEvent accepts waitUntil as an explicit parameter, not a module-level/global — a global would race across concurrent in-flight requests on the same Worker isolate", () => {
    const sigIdx = routeSrc.indexOf("async function processTelephonyEvent(");
    const sig = routeSrc.slice(sigIdx, routeSrc.indexOf(")", routeSrc.indexOf("{", sigIdx)));
    assert.match(sig, /waitUntil:\s*WaitUntil\s*\|\s*undefined/);
  });
});

describe("CallSid correlation diagnostics (production incident: media route said 'No known call' for a CallSid the webhook may never have processed)", () => {
  test("the request is logged as received BEFORE signature verification can reject it silently", () => {
    const receivedIdx = routeSrc.indexOf('console.info("telephony:webhook_request_received"');
    const verifyIdx = routeSrc.indexOf("adapter.verifyWebhookSignature(");
    assert.ok(receivedIdx > -1 && verifyIdx > -1);
    assert.ok(
      receivedIdx < verifyIdx,
      "expected the receipt log before signature verification, so a 401 still leaves a trace",
    );
  });

  test("a signature verification failure is logged, not silently 401'd", () => {
    const idx = routeSrc.indexOf("if (!adapter.verifyWebhookSignature(raw, headers, url)) {");
    assert.ok(idx > -1);
    const block = routeSrc.slice(idx, idx + 250);
    assert.match(block, /console\.error\("telephony:webhook_signature_invalid"/);
  });

  test("provider_call_id is masked (via the shared maskCallSid helper) everywhere this route logs it, never printed raw", () => {
    assert.match(
      routeSrc,
      /import \{ maskCallSid \} from "@\/lib\/telephony\/media-session-authorization\.server";/,
    );
    // The only two places the raw value legitimately appears are the actual
    // call_logs INSERT/UPDATE payloads (the stored value itself, not a log)
    // — the resolved-outbound-call backfill update, and the new-row insert.
    const rawOccurrences = [
      ...routeSrc.matchAll(/provider_call_id: event\.providerCallId(?!\s*\?)/g),
    ];
    assert.equal(
      rawOccurrences.length,
      2,
      "expected exactly two unmasked provider_call_id sites — the two DB write payloads",
    );
  });
});
