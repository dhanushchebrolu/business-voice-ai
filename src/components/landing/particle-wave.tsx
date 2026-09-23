import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/**
 * The animated dotted wave/particle landscape — ClickAI's own visual
 * language for "a living communication network," built as an original
 * canvas implementation (no imagery, geometry, or asset traced from any
 * reference site). A grid of small dots forms flowing vertical columns
 * whose height breathes with layered sine waves; cursor proximity gently
 * lifts nearby columns; an external `amplitude` signal (driven by the
 * voice-demo player, 0-1) adds a real-time boost while audio is playing.
 *
 * Deliberately plain Canvas 2D, not WebGL: at the dot counts used here
 * (a few hundred to ~1500 depending on viewport) a 2D canvas comfortably
 * holds 60fps without the complexity/bundle cost of a WebGL pipeline.
 *
 * Performance/lifecycle discipline:
 * - requestAnimationFrame loop only runs while the canvas is on-screen
 *   (IntersectionObserver) and the user hasn't requested reduced motion.
 * - ResizeObserver redraws at the container's actual size (devicePixelRatio-
 *   aware) instead of polling.
 * - Every listener/observer/rAF handle is torn down on unmount.
 * - prefers-reduced-motion: renders exactly one static frame, no loop, no
 *   cursor tracking — the visual is still present, just still.
 */

export interface ParticleWaveProps {
  className?: string;
  /** 0-1 external signal (e.g. the voice-demo player's current output level) that boosts wave amplitude while non-zero. */
  amplitude?: number;
  /** Dot color family — pick the one that reads against this section's background. */
  tone?: "on-dark" | "on-light";
  /** Lower dot count / stillness for a background accent (e.g. behind the final CTA) vs. the hero's full landscape. */
  variant?: "hero" | "subtle";
}

interface ColumnState {
  phaseA: number;
  phaseB: number;
  speedA: number;
  speedB: number;
  baseHeight: number;
  cursorLift: number;
}

export function ParticleWave({
  className,
  amplitude = 0,
  tone = "on-dark",
  variant = "hero",
}: ParticleWaveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const amplitudeRef = useRef(amplitude);
  const reducedMotion = usePrefersReducedMotion();

  amplitudeRef.current = amplitude;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let columns: ColumnState[] = [];
    let cursorX = -1000;
    let t = 0;
    let rafId = 0;
    let visible = false;

    const spacing = variant === "hero" ? 10 : 16;
    const dotSize = variant === "hero" ? 1.6 : 1.3;
    const rowSpacing = 6;
    const baseColor = tone === "on-dark" ? "245, 246, 250" : "23, 24, 30";

    function buildColumns() {
      const count = Math.max(24, Math.floor(width / spacing));
      columns = Array.from({ length: count }, () => ({
        phaseA: Math.random() * Math.PI * 2,
        phaseB: Math.random() * Math.PI * 2,
        speedA: 0.5 + Math.random() * 0.3,
        speedB: 0.3 + Math.random() * 0.25,
        baseHeight: 0.35 + Math.random() * 0.25,
        cursorLift: 0,
      }));
    }

    const resize = () => {
      const rect = container.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildColumns();
      if (reducedMotion) drawFrame();
    };

    const drawFrame = () => {
      ctx.clearRect(0, 0, width, height);
      const amp = amplitudeRef.current;
      const maxRows = Math.floor(height / 2 / rowSpacing);

      columns.forEach((col, i) => {
        const x = i * spacing + spacing / 2;
        const dx = Math.abs(x - cursorX);
        const targetLift = dx < 140 ? (1 - dx / 140) * 0.35 : 0;
        col.cursorLift += (targetLift - col.cursorLift) * 0.08;

        const wave =
          Math.sin(t * col.speedA + col.phaseA) * 0.55 +
          Math.sin(t * col.speedB * 1.6 + col.phaseB) * 0.45;
        const travel = Math.sin(t * 0.4 + i * 0.18) * 0.15;
        const level = Math.max(
          0,
          Math.min(1, col.baseHeight + wave * 0.3 + travel + col.cursorLift + amp * 0.5),
        );
        const rows = Math.round(level * maxRows);

        for (let r = 0; r < rows; r++) {
          const y = height / 2 + (r - rows / 2) * rowSpacing;
          const fade = 1 - r / Math.max(1, maxRows);
          const alpha = Math.max(0.04, fade * 0.55);
          ctx.beginPath();
          ctx.fillStyle = `rgba(${baseColor}, ${alpha.toFixed(3)})`;
          ctx.arc(x, y, dotSize, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    };

    const loop = () => {
      t += 0.016;
      drawFrame();
      rafId = requestAnimationFrame(loop);
    };

    const startLoop = () => {
      if (rafId || reducedMotion) return;
      rafId = requestAnimationFrame(loop);
    };
    const stopLoop = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      cursorX = e.clientX - rect.left;
    };
    const onPointerLeave = () => {
      cursorX = -1000;
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        if (visible) startLoop();
        else stopLoop();
      },
      { threshold: 0.05 },
    );
    intersectionObserver.observe(container);

    if (!reducedMotion) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerleave", onPointerLeave);
    }

    return () => {
      stopLoop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [tone, variant, reducedMotion]);

  return (
    <div ref={containerRef} className={className} aria-hidden="true">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
