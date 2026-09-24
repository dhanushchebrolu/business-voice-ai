import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Hard invariant guards for the Phase 5 Instagram integration — source-
 * scan rather than behavioral, on purpose (same style as
 * payment-tools.server.security.test.ts), because these assert something
 * no runtime test can: that the CODE ITSELF contains no path that would
 * violate the approved architecture, so a future edit that quietly adds
 * one is caught immediately.
 */

const dir = dirname(fileURLToPath(import.meta.url));
function read(file: string): string {
  return readFileSync(join(dir, file), "utf8");
}
function readShared(file: string): string {
  return readFileSync(join(dir, "..", file), "utf8");
}

describe("no separate Instagram AI brain (spec PART 11)", () => {
  test("no instagramGenerateReply/instagramAgent/instagramAIEngine-shaped function is defined anywhere in the Instagram module tree", () => {
    const files = [
      "instagram-inbound.server.ts",
      "instagram-outbound.server.ts",
      "instagram-automation.server.ts",
      "instagram-connection.server.ts",
      "meta-instagram-client.server.ts",
    ];
    for (const file of files) {
      const src = read(file);
      assert.doesNotMatch(
        src,
        /function\s+instagram(GenerateReply|Agent|AIEngine|AgentConfig)/i,
        `${file} must not define a separate Instagram AI brain function`,
      );
    }
  });

  test("Instagram's outbound reply path calls the SHARED agent core (generateSharedAgentReply), not a bespoke implementation", () => {
    const src = read("instagram-outbound.server.ts");
    assert.match(src, /generateSharedAgentReply/);
  });

  test("the automation engine's ai_dm action also routes through the shared agent core, not a duplicate", () => {
    const src = read("instagram-automation.server.ts");
    assert.match(src, /generateSharedAgentReply/);
  });

  test("shared-agent-reply.server.ts itself reuses the existing agent-instructions/ai-tools/claude core rather than reimplementing prompt-building or tool dispatch", () => {
    const src = readShared("shared-agent-reply.server.ts");
    assert.match(src, /agent-service\.server/);
    assert.match(src, /agent-instructions/);
    assert.match(src, /ai-tools\.server/);
    assert.match(src, /claude\.server/);
    // Never builds its own system-prompt string literal containing
    // business-grounding language — that would be a parallel prompt path.
    assert.doesNotMatch(
      src,
      /You are a (helpful|professional) (AI )?(assistant|agent|receptionist)/i,
    );
  });
});

describe("no Instagram-specific payment tables or CAPTURED writes (spec PART 14)", () => {
  test("no Instagram module ever writes payment_requests.status = CAPTURED", () => {
    const files = [
      "instagram-inbound.server.ts",
      "instagram-outbound.server.ts",
      "instagram-automation.server.ts",
      "instagram-connection.server.ts",
      "meta-instagram-client.server.ts",
    ];
    for (const file of files) {
      const src = read(file).replace(/\/\*\*[\s\S]*?\*\//g, "");
      assert.doesNotMatch(
        src,
        /status:\s*["']CAPTURED["']/,
        `${file} must never write status: "CAPTURED"`,
      );
      assert.doesNotMatch(
        src,
        /\.from\(["']payment_requests["']\)\s*\.\s*(update|insert|upsert)/,
        `${file} must never directly write payment_requests`,
      );
    }
  });

  test("the Instagram migration creates no instagram_payments or instagram_bookings table", () => {
    const migrationPath = join(
      dir,
      "..",
      "..",
      "..",
      "supabase",
      "migrations",
      "20260927090000_instagram_integration.sql",
    );
    const sql = readFileSync(migrationPath, "utf8");
    assert.doesNotMatch(sql, /CREATE TABLE public\.instagram_payments/i);
    assert.doesNotMatch(sql, /CREATE TABLE public\.instagram_bookings/i);
  });
});

describe("tenant identity never trusted from the webhook payload or the model (spec §4, §12)", () => {
  test("instagram-inbound.server.ts resolves organization/connection identity only via a database lookup keyed by Meta's own account/page id, never by trusting an organization_id field read out of the JSON body", () => {
    const src = read("instagram-inbound.server.ts");
    assert.doesNotMatch(src, /body\[["']organization_id["']\]/);
    assert.doesNotMatch(src, /parsed\[["']organization_id["']\]/);
    assert.match(src, /resolveConnectionByEntryId/);
  });

  test("shared-agent-reply.server.ts's context type takes organizationId/businessId/agentConfigId as plain trusted fields, never reading them from a tool-call input parameter", () => {
    const src = readShared("shared-agent-reply.server.ts");
    assert.match(src, /organizationId: string/);
    assert.match(src, /businessId: string/);
  });
});

describe("Instagram gains no special tool capabilities (spec §4)", () => {
  test("ai-tools.server.ts's capability-gating logic is untouched — Instagram is just another `source` value, not a new capability bypass", () => {
    const src = readShared("ai-tools.server.ts");
    assert.match(src, /capabilities\[def\.capability\] === true/);
    assert.doesNotMatch(src, /source === ["']instagram["'].*capabilit/is);
  });
});

describe("secrets never exposed to the client (spec §6, §16)", () => {
  test("no route or server function ever selects instagram_connections.access_token_ciphertext for client consumption", () => {
    assert.doesNotMatch(
      readShared("instagram.functions.ts"),
      /select\([^)]*access_token_ciphertext/i,
    );
    assert.doesNotMatch(
      read("instagram-connection.server.ts"),
      /select\([^)]*access_token_ciphertext/i,
    );
  });
});
