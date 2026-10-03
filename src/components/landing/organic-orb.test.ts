import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "organic-orb.tsx"),
  "utf8",
);

describe("OrganicOrb is a continuously-deforming 3D mesh, never a static sphere, video, GIF, or CSS-only loop", () => {
  test("drives its animation from React Three Fiber's real frame loop (useFrame), not setInterval/a CSS keyframe loop", () => {
    assert.match(src, /import \{ Canvas, useFrame \} from "@react-three\/fiber"/);
    assert.match(src, /useFrame\(\(state, delta\) => \{/);
    assert.doesNotMatch(src, /setInterval/);
  });

  test("deforms real geometry vertices in a vertex shader (not a static mesh plus a CSS transform)", () => {
    assert.match(src, /icosahedronGeometry/);
    assert.match(src, /vec3 newPosition = position \+ normal \* displacement/);
    assert.match(src, /gl_Position = projectionMatrix \* modelViewMatrix \* vec4\(newPosition, 1\.0\)/);
  });

  test("the deformation is driven by noise functions of a monotonically increasing time uniform, not Math.random per frame", () => {
    assert.match(src, /float snoise\(vec3 v\)/);
    assert.match(src, /float fbm\(vec3 p\)/);
    assert.match(src, /uniform float uTime/);
    assert.doesNotMatch(src, /Math\.random/);
  });

  test("base idle energy is never zero, so the blob keeps morphing with zero audio input and zero interaction", () => {
    const idx = src.indexOf("const targetEnergy");
    assert.ok(idx > -1);
    const line = src.slice(idx, src.indexOf("\n", idx));
    assert.match(line, /speaking \? .+ : 0\.\d/);
  });

  test("time keeps advancing every frame regardless of state — only its rate changes, it never pauses or resets", () => {
    assert.match(src, /timeOffset\.current \+= delta \* timeSpeed/);
    assert.match(src, /uniforms\.uTime\.value = timeOffset\.current/);
    assert.doesNotMatch(src, /uTime\.value = 0;/);
  });

  test("rotation and a breathing bob run every frame unconditionally — never gated behind a 'playing' check", () => {
    const idx = src.indexOf("useFrame((state, delta) => {");
    assert.ok(idx > -1);
    const body = src.slice(idx, src.indexOf("\n  });", idx));
    assert.doesNotMatch(body, /if\s*\(\s*speaking\s*\)\s*\{[\s\S]*meshRef\.current\.rotation/);
    assert.match(body, /meshRef\.current\.rotation\.y \+= delta \* rotSpeed/);
    assert.match(body, /meshRef\.current\.position\.y = Math\.sin/);
  });

  test("speaking layers real playback amplitude on top of the base motion, never replacing it", () => {
    assert.match(
      src,
      /const targetEnergy = speaking \? 0\.\d+ \+ Math\.min\(amplitude, 1\) \* 0\.\d+ : 0\.\d+;/,
    );
  });

  test("not a video/GIF/image element anywhere in the component", () => {
    assert.doesNotMatch(src, /<video/);
    assert.doesNotMatch(src, /<img/);
    assert.doesNotMatch(src, /\.gif|\.mp4|\.webm/);
  });

  test("is client-only (WebGL needs a browser) — mounts the Canvas only after a browser mount effect, with a non-WebGL SSR fallback", () => {
    assert.match(src, /const \[mounted, setMounted\] = useState\(false\)/);
    assert.match(src, /useEffect\(\(\) => \{\s*setMounted\(true\);/);
    assert.match(src, /if \(!mounted\) \{/);
    assert.match(src, /import \{ OrganicOrbFallback \} from "\.\/organic-orb-fallback"/);
    assert.match(src, /return <OrganicOrbFallback className=\{className\} \/>;/);
  });

  test("respects prefers-reduced-motion by dampening speed/energy, not by going fully static", () => {
    assert.match(src, /usePrefersReducedMotion/);
    assert.match(src, /reducedMotion \? 0\.\d+/);
  });
});
