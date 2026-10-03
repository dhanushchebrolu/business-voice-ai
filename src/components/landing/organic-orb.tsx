import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { OrganicOrbFallback } from "./organic-orb-fallback";

/**
 * Continuously-deforming 3D blob — the hero's "this AI agent is alive"
 * visual. Never idle/static: the geometry's vertices are displaced every
 * frame inside the vertex shader by a dominant twisted-ribbon swirl motif
 * (two sine bands wrapping the Y axis at irrational-ratio time speeds)
 * layered over secondary 3D simplex noise (fbm), all evaluated at a
 * monotonically increasing time uniform, so the silhouette is always
 * stretching/compressing/rippling even with zero audio input. The
 * fragment shader shades it like matte clay -- a fixed key light plus a
 * displacement-driven ambient-occlusion proxy, not a glowing rim light --
 * with a soft edge fade instead of a hard geometric silhouette.
 * `amplitude`/`speaking` (both real signals from the caller's actual
 * AnalyserNode — see hero-voice-demo.tsx) layer extra energy ON TOP of
 * that base motion; they never replace or gate it.
 *
 * Deliberately NOT: a static sphere + CSS rotation, a video/GIF, or a
 * canned keyframe loop — every frame's displacement is a fresh function of
 * `uTime`, driven by `useFrame`, with no repeating cycle short enough to
 * read as "looping" and no per-frame randomness (fully deterministic: the
 * same elapsed time always produces the same shape).
 */

// Ashima Arts' webgl-noise 3D simplex noise (MIT) — the standard, widely-
// embedded GLSL implementation; this is the only known-good description
// basis small enough to inline directly in a vertex shader string.
const SIMPLEX_NOISE_GLSL = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const VERTEX_SHADER = `
  uniform float uTime;
  uniform float uEnergy;
  varying vec3 vNormal;
  varying float vDisplacement;

  ${SIMPLEX_NOISE_GLSL}

  float fbm(vec3 p) {
    float value = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amp * snoise(p);
      p *= 2.02;
      amp *= 0.5;
    }
    return value;
  }

  // Two independent, irrational-ratio time drifts (0.17/0.13/0.11 vs
  // 0.06/0.08/0.05) so the fbm contribution never repeats on a period
  // short enough to read as a loop. Dominant ribbed motif: parallel bands
  // running across the sphere, like twisted clay, built as plane waves
  // (sin of a dot product with a fixed, normalized direction) rather than
  // a position-dependent rotation -- a rotation-based twist amplifies its
  // own gradient near the equator (points far from the rotation axis
  // sweep through a much longer arc per unit of angle change), which
  // produced steep local folds even when the final displacement was
  // clamped. A plane wave's gradient is the same fixed, small value
  // everywhere by construction, so it can never locally crease regardless
  // of mesh resolution. Two bands at different fixed directions and
  // irrational-ratio time speeds (0.37 vs 0.24) combine into a
  // non-obviously-repeating ripple; the mesh's own independent rotation
  // (see useFrame below) makes the bands' apparent on-screen orientation
  // slowly turn over time. Hard-clamped (not just tuned low) so no
  // combination of swirl/noise phases, nor the "speaking" energy spike,
  // can ever push a vertex far enough inward to pass near the opposite
  // side of a 1.3-radius sphere -- which would read as a self-intersecting
  // "bite" taken out of the blob.
  float computeDisplacement(vec3 pos, float t, float energyAmt) {
    vec3 flowA = pos * 1.1 + vec3(t * 0.17, t * 0.13, t * 0.11);
    vec3 flowB = pos * 0.45 + vec3(-t * 0.06, t * 0.08, -t * 0.05);
    float fine = fbm(flowA);
    float coarse = fbm(flowB);

    vec3 bandDirA = normalize(vec3(0.6, 1.0, 0.3));
    vec3 bandDirB = normalize(vec3(-0.4, 0.7, 0.9));
    float swirlA = sin(dot(pos, bandDirA) * 2.6 + t * 0.37);
    float swirlB = sin(dot(pos, bandDirB) * 1.9 - t * 0.24);
    float swirl = swirlA * 0.6 + swirlB * 0.4;

    return clamp((swirl * 1.4 + coarse * 0.55 + fine * 0.2) * (0.55 + energyAmt), -0.85, 0.85);
  }

  void main() {
    float displacement = computeDisplacement(position, uTime, uEnergy);
    vDisplacement = displacement;

    vec3 newPosition = position + normal * displacement;

    // Three.js never recomputes normals for vertex-shader displacement, so
    // lighting would otherwise use the original smooth-sphere normal
    // against a now-bumpy surface -- which reads as sharp, wrong creases
    // at the ribbing instead of smooth rounded bumps. Recover the true
    // surface normal by sampling two nearby points along the local tangent
    // plane and taking the cross product of the resulting displaced edges.
    vec3 tangent = normalize(cross(normal, abs(normal.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 bitangent = cross(normal, tangent);
    float eps = 0.02;
    vec3 posU = position + tangent * eps;
    vec3 posV = position + bitangent * eps;
    vec3 newPosU = posU + normal * computeDisplacement(posU, uTime, uEnergy);
    vec3 newPosV = posV + normal * computeDisplacement(posV, uTime, uEnergy);
    vec3 displacedNormal = normalize(cross(newPosU - newPosition, newPosV - newPosition));
    if (dot(displacedNormal, normal) < 0.0) displacedNormal = -displacedNormal;

    vNormal = normalize(normalMatrix * displacedNormal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  uniform vec3 uColorShadow;
  uniform vec3 uColorBase;
  uniform vec3 uColorHighlight;
  uniform float uEnergy;
  varying vec3 vNormal;
  varying float vDisplacement;

  void main() {
    vec3 n = normalize(vNormal);

    // A fixed key light in view space (not purely angle-of-view/fresnel
    // driven) so the lit side stays believably top-left regardless of the
    // mesh's own rotation -- a soft matte-clay look rather than a glowing
    // rim-lit sphere.
    vec3 lightDir = normalize(vec3(-0.5, 0.8, 0.6));
    float lambert = dot(n, lightDir) * 0.5 + 0.5;

    // The ridges/valleys from the vertex displacement double as a cheap
    // ambient-occlusion proxy: valleys read darker, peaks catch more light.
    float ao = clamp(vDisplacement * 0.5 + 0.5, 0.0, 1.0);
    float shade = clamp(lambert * 0.7 + ao * 0.3, 0.0, 1.0);

    vec3 color = mix(uColorShadow, uColorBase, smoothstep(0.15, 0.6, shade));
    color = mix(color, uColorHighlight, smoothstep(0.68, 1.0, shade));

    // A faint rim accent, not a bright glow -- most of the shape-reading
    // comes from the lambert/AO gradient above.
    float rim = pow(1.0 - abs(n.z), 3.0);
    color = mix(color, uColorHighlight, rim * 0.1);

    // Soft edge fade toward transparent at grazing angles -- the hazy,
    // soft-focus silhouette instead of a hard geometric edge.
    float edgeFresnel = pow(1.0 - abs(n.z), 5.0);
    float alpha = 1.0 - edgeFresnel * 0.35;

    gl_FragColor = vec4(color, alpha);
  }
`;

interface BlobMeshProps {
  amplitude: number;
  speaking: boolean;
  reducedMotion: boolean;
}

function BlobMesh({ amplitude, speaking, reducedMotion }: BlobMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const smoothEnergy = useRef(0);
  const timeOffset = useRef(0);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uColorShadow: { value: new THREE.Color("#1a2a73") },
      uColorBase: { value: new THREE.Color("#2f4fe0") },
      uColorHighlight: { value: new THREE.Color("#8fa6f5") },
    }),
    [],
  );

  useFrame((state, delta) => {
    // Base idle energy is never zero — this is what keeps the blob
    // continuously morphing even with no audio and no interaction at all.
    // Speaking layers the real playback amplitude on top as extra energy.
    const targetEnergy = speaking ? 0.45 + Math.min(amplitude, 1) * 0.85 : 0.22;
    const smoothing = reducedMotion ? 1.5 : 3;
    smoothEnergy.current += (targetEnergy - smoothEnergy.current) * Math.min(delta * smoothing, 1);
    uniforms.uEnergy.value = smoothEnergy.current;

    // Time itself keeps advancing identically regardless of state — only
    // its rate changes (slower while "thinking"/idle, slightly livelier
    // while speaking) — satisfying "motion never stops, speed modulates."
    const timeSpeed = reducedMotion ? 0.12 : speaking ? 0.62 : 0.4;
    timeOffset.current += delta * timeSpeed;
    uniforms.uTime.value = timeOffset.current;

    if (meshRef.current) {
      const rotSpeed = reducedMotion ? 0.015 : 0.09;
      meshRef.current.rotation.y += delta * rotSpeed;
      meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.08) * 0.18;
      meshRef.current.rotation.z = Math.cos(state.clock.elapsedTime * 0.06) * 0.08;
      // Subtle breathing bob — never fully still on any axis.
      meshRef.current.position.y = Math.sin(state.clock.elapsedTime * 0.35) * 0.05;
    }
  });

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1.3, 5]} />
      <shaderMaterial
        vertexShader={VERTEX_SHADER}
        fragmentShader={FRAGMENT_SHADER}
        uniforms={uniforms}
        transparent
      />
    </mesh>
  );
}

export interface OrganicOrbProps {
  /** Real playback-amplitude signal (0-1), e.g. from an AnalyserNode average — never fabricated. */
  amplitude?: number;
  /** True while real audio is actively playing — layers extra, amplitude-driven energy on the always-on base motion. */
  speaking?: boolean;
  className?: string;
}

/**
 * Client-only (WebGL requires a browser): renders a static gradient-circle
 * fallback until mounted, so SSR never attempts to touch `window`/WebGL and
 * there's no hydration mismatch or layout shift once the canvas takes over.
 */
export function OrganicOrb({ amplitude = 0, speaking = false, className }: OrganicOrbProps) {
  const [mounted, setMounted] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <OrganicOrbFallback className={className} />;
  }

  return (
    <Canvas
      className={className}
      camera={{ position: [0, 0, 3.2], fov: 38 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      style={{ pointerEvents: "none" }}
    >
      <ambientLight intensity={0.7} />
      <pointLight position={[2.5, 2, 3]} intensity={1.4} color="#a78bfa" />
      <pointLight position={[-2, -1.5, 2]} intensity={0.9} color="#60a5fa" />
      <BlobMesh amplitude={amplitude} speaking={speaking} reducedMotion={prefersReducedMotion} />
    </Canvas>
  );
}
