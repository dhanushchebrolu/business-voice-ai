import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mixHex, rgba } from "./orb-color.ts";
import { blendStates, createStateMix, ENTER_RATE, SETTLE_RATE, stateRate } from "./orb-state.ts";

describe("mixHex", () => {
  test("returns the endpoints at t=0 and t=1", () => {
    assert.equal(mixHex("#ff0000", "#0000ff", 0), "#ff0000");
    assert.equal(mixHex("#ff0000", "#0000ff", 1), "#0000ff");
  });

  test("mixes in linear light so the midpoint is brighter than sRGB averaging", () => {
    assert.equal(mixHex("#000000", "#ffffff", 0.5), "#bcbcbc");
  });
});

describe("rgba", () => {
  test("clamps alpha", () => {
    assert.equal(rgba([10, 20, 30], 2), "rgba(10,20,30,1.000)");
  });
});

describe("stateRate", () => {
  test("enters active states faster than it settles back to idle", () => {
    assert.equal(stateRate("listening"), ENTER_RATE);
    assert.equal(stateRate("idle"), SETTLE_RATE);
    assert.ok(ENTER_RATE > SETTLE_RATE);
  });

  test("reaches most of an active state within about 0.2 s", () => {
    const mix = createStateMix("idle");
    for (let i = 0; i < 12; i++) mix.update("speaking", 1 / 60);
    assert.ok(mix.weights.speaking > 0.9);
  });
});

describe("blendStates", () => {
  test("blends per-state parameter tables by weight", () => {
    const row = (v: number) => ({ v });
    const table = {
      idle: row(0),
      connecting: row(0),
      listening: row(10),
      thinking: row(0),
      speaking: row(0),
      error: row(0),
      disabled: row(0),
    };
    const weights = { ...createStateMix("idle").weights, idle: 0.5, listening: 0.5 };
    assert.equal(blendStates(weights, table).v, 5);
  });
});
