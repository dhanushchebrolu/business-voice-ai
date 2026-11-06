import { useEffect, useRef, type ReactNode } from "react";

/**
 * Click sparks, adapted from React Bits' ClickSpark (line shape only: the other
 * shapes, gravity, ring and imperative handle are not used here and were dropped).
 * One short-lived canvas per burst, removed when it ends; a single rAF loop that
 * runs only while sparks exist; the layer never takes pointer events.
 *
 * Differences from the original, on purpose: sparks fire only for presses on
 * interactive elements (not on every click on the page), do not run at all under
 * prefers-reduced-motion, and sit above the fixed header.
 */

const EASE = (t: number) => 1 - Math.pow(1 - t, 3); // ease-out
const MAX_BURSTS = 12;
const INTERACTIVE =
  'a[href], button, summary, select, input, textarea, label, [role="button"], [role="tab"], [role="slider"], [role="link"]';

type Spark = { angle: number; reach: number; scale: number; life: number; color: string };
type Burst = {
  x: number;
  y: number;
  start: number;
  sparks: Spark[];
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  ratio: number;
  left: number;
  top: number;
};

export function ClickSpark({
  colors = ["#356DFF", "#5B2CFF"],
  size = 10,
  radius = 24,
  count = 6,
  width = 1.5,
  duration = 400,
  randomness = 0.2,
  className,
  children,
}: {
  colors?: string[];
  size?: number;
  radius?: number;
  count?: number;
  width?: number;
  duration?: number;
  randomness?: number;
  className?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLSpanElement>(null);
  const cfg = useRef({ colors, size, radius, count, width, duration, randomness });
  cfg.current = { colors, size, radius, count, width, duration, randomness };

  useEffect(() => {
    const rootEl = root.current;
    const layerEl = layer.current;
    if (!rootEl || !layerEl || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;

    const bursts: Burst[] = [];
    let raf = 0;
    let lastPress = { time: -1e9, x: 0, y: 0 };

    const remove = (b: Burst) => {
      b.canvas.remove();
      const i = bursts.indexOf(b);
      if (i >= 0) bursts.splice(i, 1);
    };

    const frame = (now: number) => {
      raf = 0;
      for (const b of [...bursts]) {
        const c = cfg.current;
        const { ctx } = b;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, b.canvas.width, b.canvas.height);
        ctx.setTransform(b.ratio, 0, 0, b.ratio, -b.left * b.ratio, -b.top * b.ratio);
        let alive = false;
        for (const s of b.sparks) {
          const p = (now - b.start) / (c.duration * s.life);
          if (p >= 1) continue;
          alive = true;
          const dist = c.radius * s.reach * EASE(Math.min(1, Math.max(0, p)));
          const len = c.size * s.scale * Math.pow(1 - p, 1.6);
          const dx = Math.cos(s.angle);
          const dy = Math.sin(s.angle);
          const fade = 1 - Math.min(1, Math.max(0, (p - 0.55) / 0.45));
          ctx.strokeStyle = s.color;
          ctx.globalAlpha = fade;
          ctx.lineWidth = c.width * s.scale;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(b.x + dx * dist, b.y + dy * dist);
          ctx.lineTo(
            b.x + dx * (dist + Math.max(0.01, len)),
            b.y + dy * (dist + Math.max(0.01, len)),
          );
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (!alive) remove(b);
      }
      if (bursts.length) raf = requestAnimationFrame(frame);
    };

    const spawn = (x: number, y: number) => {
      const c = cfg.current;
      const rect = rootEl.getBoundingClientRect();
      const reach = c.radius * 1.35 + c.size * 1.4 + c.width * 2 + 6;
      const box = {
        left: Math.max(x - reach, 0),
        top: Math.max(y - reach, 0),
        right: Math.min(x + reach, window.innerWidth),
        bottom: Math.min(y + reach, window.innerHeight),
      };
      if (box.right - box.left < 1 || box.bottom - box.top < 1) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil((box.right - box.left) * ratio);
      canvas.height = Math.ceil((box.bottom - box.top) * ratio);
      Object.assign(canvas.style, {
        position: "absolute",
        left: `${box.left - rect.left}px`,
        top: `${box.top - rect.top}px`,
        width: `${box.right - box.left}px`,
        height: `${box.bottom - box.top}px`,
        display: "block",
        pointerEvents: "none",
      });
      canvas.setAttribute("aria-hidden", "true");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      layerEl.appendChild(canvas);
      const step = (Math.PI * 2) / c.count;
      const jitter = () => (Math.random() - 0.5) * c.randomness;
      const offset = Math.floor(Math.random() * c.colors.length);
      const sparks: Spark[] = Array.from({ length: c.count }, (_, i) => ({
        angle: -Math.PI / 2 + step * i + jitter() * step * 0.9,
        reach: 1 + jitter() * 0.7,
        scale: 1 + jitter() * 0.8,
        life: 1 + jitter() * 0.5,
        color: c.colors[(i + offset) % c.colors.length]!,
      }));
      bursts.push({
        x,
        y,
        start: performance.now(),
        sparks,
        canvas,
        ctx,
        ratio,
        left: box.left,
        top: box.top,
      });
      while (bursts.length > MAX_BURSTS) remove(bursts[0]!);
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const interactive = (e: Event) => e.target instanceof Element && e.target.closest(INTERACTIVE);

    // Mouse sparks on press; touch and keyboard sparks on the click that follows. A click that
    // lands where a mouse press just sparked is the same gesture and is skipped.
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0 || !interactive(e)) return;
      lastPress = { time: performance.now(), x: e.clientX, y: e.clientY };
      spawn(e.clientX, e.clientY);
    };
    const onClick = (e: MouseEvent) => {
      if (!interactive(e)) return;
      if (e.detail === 0) {
        const r = (e.target as Element).getBoundingClientRect();
        spawn(r.left + r.width / 2, r.top + r.height / 2);
        return;
      }
      const same =
        performance.now() - lastPress.time < 700 &&
        Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 12;
      if (!same) spawn(e.clientX, e.clientY);
    };

    rootEl.addEventListener("pointerdown", onPointerDown);
    rootEl.addEventListener("click", onClick);
    return () => {
      cancelAnimationFrame(raf);
      rootEl.removeEventListener("pointerdown", onPointerDown);
      rootEl.removeEventListener("click", onClick);
      for (const b of [...bursts]) remove(b);
    };
  }, []);

  return (
    <div ref={root} className={className} style={{ position: "relative" }}>
      {children}
      <span
        ref={layer}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 60,
          overflow: "visible",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
