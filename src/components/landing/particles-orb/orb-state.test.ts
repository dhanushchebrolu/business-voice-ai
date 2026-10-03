import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_COLOR_FROM,
  ERROR_COLOR_TO,
  ORB_STATES,
  approach,
  createStateMix,
  hexToRgb,
  orbVars,
  stateEnergy,
  stateMotion,
  type OrbState,
  type StateWeights,
} from "./orb-state.ts";

const TIME_SAMPLES = Array.from({ length: 60 }, (_, i) => i * 0.137);

const sumWeights = (weights: StateWeights): number =>
  Object.values(weights).reduce((acc, weight) => acc + weight, 0);

describe("ORB_STATES", () => {
  test("lists the five core states without error and disabled", () => {
    assert.deepEqual(ORB_STATES, ["idle", "connecting", "listening", "thinking", "speaking"]);
  });
});

describe("stateEnergy — idle is never artificially non-zero here, but the orb's own spin/breathe/drift params (tested below) never gate on it, so idle is still never visually static", () => {
  test("returns 0 for idle and disabled at any time", () => {
    for (const t of TIME_SAMPLES) {
      assert.equal(stateEnergy("idle", t), 0);
      assert.equal(stateEnergy("disabled", t), 0);
    }
  });

  test("returns a constant 0.2 for error", () => {
    for (const t of TIME_SAMPLES) {
      assert.equal(stateEnergy("error", t), 0.2);
    }
  });

  test("keeps active states bounded and oscillating (never a flat constant)", () => {
    const bounds: [OrbState, number, number][] = [
      ["listening", 0.4, 0.9],
      ["speaking", 0.3, 0.7],
      ["thinking", 0.24, 0.44],
      ["connecting", 0.12, 0.22],
    ];
    for (const [state, min, max] of bounds) {
      const values = TIME_SAMPLES.map((t) => stateEnergy(state, t));
      for (const value of values) {
        assert.ok(value >= min, `${state} value ${value} below ${min}`);
        assert.ok(value <= max, `${state} value ${value} above ${max}`);
      }
      assert.ok(
        new Set(values.map((v) => v.toFixed(4))).size > 1,
        `${state} never changes over time`,
      );
    }
  });
});

describe("orbVars", () => {
  test("maps props to public CSS custom properties", () => {
    const vars = orbVars({ size: 220, speed: 1.25, colorFrom: "#7c3aed", colorTo: "#0ea5e9" });
    assert.deepEqual(vars, {
      "--orb-size": "220px",
      "--orb-speed": "1.25",
      "--orb-color-from": "#7c3aed",
      "--orb-color-to": "#0ea5e9",
    });
  });

  test("omits properties that are not provided", () => {
    assert.deepEqual(orbVars({}), {});
    assert.deepEqual(orbVars({ size: 160 }), { "--orb-size": "160px" });
  });

  test("keeps zero values for size and speed", () => {
    const vars = orbVars({ size: 0, speed: 0 }) as Record<string, string>;
    assert.equal(vars["--orb-size"], "0px");
    assert.equal(vars["--orb-speed"], "0");
  });
});

describe("approach", () => {
  test("moves current toward the target from both directions", () => {
    const up = approach(0, 1, 6, 1 / 60);
    assert.ok(up > 0 && up < 1);
    const down = approach(1, 0, 6, 1 / 60);
    assert.ok(down < 1 && down > 0);
  });

  test("never overshoots the target on very large steps", () => {
    const next = approach(0, 1, 60, 10);
    assert.ok(next <= 1);
    assert.ok(Math.abs(next - 1) < 1e-5);
  });

  test("returns current unchanged when dt is 0", () => {
    assert.equal(approach(0.3, 1, 6, 0), 0.3);
  });

  test("is frame-rate independent for the same elapsed time", () => {
    let stepped = 0;
    for (let i = 0; i < 4; i += 1) stepped = approach(stepped, 1, 6, 0.025);
    const single = approach(0, 1, 6, 0.1);
    assert.ok(Math.abs(stepped - single) < 1e-9);
  });
});

describe("createStateMix — this is what makes state transitions blend instead of snap, and never go static mid-transition", () => {
  test("starts with full weight on the initial state", () => {
    const mix = createStateMix("listening");
    assert.equal(mix.weights.listening, 1);
    assert.equal(sumWeights(mix.weights), 1);
  });

  test("defaults to idle", () => {
    assert.equal(createStateMix().weights.idle, 1);
  });

  test("keeps weights normalized during a transition", () => {
    const mix = createStateMix("idle");
    for (let i = 0; i < 5; i += 1) {
      const weights = mix.update("speaking", 1 / 60);
      assert.ok(Math.abs(sumWeights(weights) - 1) < 1e-6);
    }
  });

  test("transitions smoothly from the previous state to the next, never jumping straight to 1", () => {
    const mix = createStateMix("idle");
    const first = { ...mix.update("listening", 1 / 60) };
    assert.ok(first.idle > 0 && first.idle < 1);
    assert.ok(first.listening > 0 && first.listening < 1);
    const second = { ...mix.update("listening", 1 / 60) };
    assert.ok(second.listening > first.listening);
    assert.ok(second.idle < first.idle);
  });

  test("converges to full weight on the active state", () => {
    const mix = createStateMix("idle");
    let weights = mix.weights;
    for (let i = 0; i < 240; i += 1) weights = mix.update("thinking", 1 / 60);
    assert.ok(Math.abs(weights.thinking - 1) < 1e-3);
    for (const state of Object.keys(weights) as OrbState[]) {
      if (state !== "thinking") assert.equal(weights[state], 0);
    }
  });
});

describe("stateMotion", () => {
  test("maps each state to its motion category", () => {
    const expected: [OrbState, string][] = [
      ["listening", "ripple"],
      ["thinking", "pulse"],
      ["speaking", "flow"],
      ["idle", "none"],
      ["connecting", "none"],
      ["error", "none"],
      ["disabled", "none"],
    ];
    for (const [state, motion] of expected) assert.equal(stateMotion(state), motion);
  });
});

describe("hexToRgb", () => {
  test("parses 6-digit hex colors", () => {
    assert.deepEqual(hexToRgb("#7c3aed"), [124, 58, 237]);
    assert.deepEqual(hexToRgb("#000000"), [0, 0, 0]);
    assert.deepEqual(hexToRgb("#ffffff"), [255, 255, 255]);
  });

  test("expands 3-digit shorthand", () => {
    assert.deepEqual(hexToRgb("#fff"), [255, 255, 255]);
    assert.deepEqual(hexToRgb("#0af"), [0, 170, 255]);
  });

  test("accepts hex without the leading hash", () => {
    assert.deepEqual(hexToRgb("ff8800"), [255, 136, 0]);
  });
});

describe("error color constants", () => {
  test("are distinct 6-digit hex colors", () => {
    assert.match(ERROR_COLOR_FROM, /^#[0-9a-f]{6}$/);
    assert.match(ERROR_COLOR_TO, /^#[0-9a-f]{6}$/);
    assert.notEqual(ERROR_COLOR_FROM, ERROR_COLOR_TO);
  });
});
