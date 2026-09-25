import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The channel list must honestly distinguish what's actually built
 * (WhatsApp, voice, website chat, Instagram — all wired up in this
 * codebase) from what's still on the roadmap (SMS, email) rather than
 * presenting all six as equally live.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "channels-section.tsx"),
  "utf8",
);

describe("ChannelsSection is honest about which channels are actually live", () => {
  test("lists all six channels from the spec", () => {
    for (const name of ["WhatsApp", "Instagram", "Website Chat", "Voice", "SMS", "Email"]) {
      assert.match(src, new RegExp(name));
    }
  });

  test("only channels this codebase actually implements are marked live", () => {
    const liveMatch = src.match(/CHANNELS = \[([\s\S]*?)\];/);
    assert.ok(liveMatch, "expected a CHANNELS array");
    const block = liveMatch![1]!;
    const liveNames = [...block.matchAll(/name: "([^"]+)", status: "live"/g)].map((m) => m[1]);
    assert.deepEqual(
      new Set(liveNames),
      new Set(["WhatsApp", "Voice", "Website Chat", "Instagram"]),
    );
  });
});
