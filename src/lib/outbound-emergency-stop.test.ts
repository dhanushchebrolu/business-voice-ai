import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { outboundEmergencyStopActive } from "./outbound-eligibility.server.ts";

/**
 * GATE C4 H3: the database emergency stop (platform_settings
 * 'outbound.calling_paused') as read outside the admission functions.
 */

type Answer = { data: unknown; error: unknown } | Error;
function db(answer: Answer) {
  const seen: { table?: string; key?: unknown } = {};
  const client = {
    from(table: string) {
      seen.table = table;
      return {
        select: () => ({
          eq: (_col: string, key: unknown) => {
            seen.key = key;
            return {
              maybeSingle: async () => {
                if (answer instanceof Error) throw answer;
                return answer;
              },
            };
          },
        }),
      };
    },
  };
  return { client: client as never, seen };
}
const row = (value: unknown) => ({ data: { value }, error: null });

describe("outboundEmergencyStopActive — what admission reads as stopped, and fail closed", () => {
  test("reads exactly the outbound.calling_paused setting", async () => {
    const d = db(row({ enabled: true }));
    assert.equal(await outboundEmergencyStopActive(d.client), true);
    assert.deepEqual(d.seen, { table: "platform_settings", key: "outbound.calling_paused" });
  });

  test("not stopped: no row, {enabled: false}, null, missing, or a PostgreSQL false spelling", async () => {
    const off: Answer[] = [
      { data: null, error: null },
      row({ enabled: false }),
      row({ enabled: null }),
      row({}),
      row({ enabled: "false" }),
      row({ enabled: "off" }),
      row({ enabled: "0" }),
      row({ enabled: 0 }),
      row(null),
      row("not an object"),
    ];
    for (const a of off) assert.equal(await outboundEmergencyStopActive(db(a).client), false);
  });

  test("stopped: true, or any value admission would read as true or reject", async () => {
    const on: Answer[] = [
      row({ enabled: true }),
      row({ enabled: "true" }),
      row({ enabled: "yes" }),
      row({ enabled: 1 }),
      row({ enabled: "maybe" }),
    ];
    for (const a of on) assert.equal(await outboundEmergencyStopActive(db(a).client), true);
  });

  test("a failed or thrown read counts as stopped", async () => {
    assert.equal(
      await outboundEmergencyStopActive(db({ data: null, error: { message: "timeout" } }).client),
      true,
    );
    assert.equal(await outboundEmergencyStopActive(db(new Error("network")).client), true);
  });
});

describe("campaign launch and resume refuse while the emergency stop is on", () => {
  const src = readFileSync(new URL("./campaigns.functions.ts", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const launch = src.slice(src.indexOf("export const launchCampaign"));

  test("launch checks the stop, with a clear message, before the campaign can be set running", () => {
    const check = launch.indexOf(
      "if (await outboundEmergencyStopActive(supabaseAdmin))\n      throw new Error(OUTBOUND_EMERGENCY_STOP_MESSAGE);",
    );
    const running = launch.indexOf('status: "running"');
    assert.ok(check > -1, "emergency stop checked");
    assert.ok(check < launch.indexOf('.from("campaigns")') && check < running);
  });

  test("resume is the same function as launch, so it runs the same check", () => {
    assert.match(src, /export const resumeCampaign = launchCampaign;/);
  });
});
