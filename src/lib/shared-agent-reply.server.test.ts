import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * generateSharedAgentReply calls Claude and the database, so — like the
 * other model-backed paths — the tool-exclusion contract is checked in
 * the source: an excluded tool is neither offered nor executed.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "shared-agent-reply.server.ts"),
  "utf8",
);

describe("excludeToolNames", () => {
  test("excluded tools are filtered out of the tools offered to the model", () => {
    assert.match(src, /\(tool\) => !excluded\.has\(tool\.name\)/);
  });

  test("an excluded tool the model asks for anyway is refused, never executed", () => {
    const idx = src.indexOf(": excluded.has(name)");
    assert.ok(idx > -1);
    const branch = src.slice(idx, src.indexOf(":", src.indexOf("TOOL_NOT_PERMITTED", idx)));
    assert.match(branch, /TOOL_NOT_PERMITTED/);
    assert.doesNotMatch(branch, /executeAiTool/);
  });
});

describe("channel tools (extraTools)", () => {
  test("are offered alongside permitted tools and executed by the channel, never by the registry", () => {
    assert.match(src, /\.\.\.\[\.\.\.channelTools\.values\(\)\]\.map\(\(t\) => t\.schema\)/);
    assert.match(
      src,
      /channelTools\.has\(name\)\s*\?\s*channelTools\.get\(name\)!\.execute\(input\)/,
    );
  });

  test("a registry tool with the same name as a channel tool is never offered twice", () => {
    assert.match(src, /!channelTools\.has\(tool\.name\)/);
  });
});
