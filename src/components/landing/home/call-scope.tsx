import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Scrolling waveform ("scope"): the recording's real peaks slide under a fixed
 * playhead, bars before it lit, bars after it dim, with a seconds ruler. Drawn on a
 * canvas by position, never by React render: `draw()` is called from the player's
 * rAF loop while playing or dragging, and once on any other change (seek, resize,
 * theme, peaks arriving).
 */

export const PEAKS_PER_SECOND = 24;
const WINDOW_SECONDS = 6;
const PLAYHEAD = 0.7; // playhead position across the scope, 0..1
const RULER = 22;

export type ScopeHandle = {
  draw: (time: number) => void;
  pxPerSecond: () => number;
  playheadX: () => number;
};

type Colors = { lit: string; dim: string; ink: string; muted: string; hair: string };

function readColors(el: HTMLElement): Colors {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    lit: v("--vx-accent"),
    dim: v("--vx-faint"),
    ink: v("--vx-ink"),
    muted: v("--vx-muted"),
    hair: v("--vx-hair"),
  };
}

export function CallScope({
  peaks,
  duration,
  theme,
  handleRef,
  className,
}: {
  peaks: number[] | null;
  duration: number;
  /** Only used to redraw when the theme changes. */
  theme: string;
  handleRef: React.MutableRefObject<ScopeHandle | null>;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const colors = useRef<Colors | null>(null);
  const size = useRef({ w: 0, h: 0 });
  const last = useRef(0);

  const draw = useCallback(
    (time: number) => {
      last.current = time;
      const c = canvas.current;
      const ctx = c?.getContext("2d");
      const col = colors.current;
      const { w, h } = size.current;
      if (!c || !ctx || !col || !w) return;
      ctx.clearRect(0, 0, w, h);
      const plot = h - RULER;
      const px = w / WINDOW_SECONDS;
      const headX = w * PLAYHEAD;
      const mid = plot / 2;

      // guide lines
      ctx.fillStyle = col.hair;
      for (const y of [plot * 0.2, mid, plot * 0.8]) ctx.fillRect(0, Math.round(y), w, 1);

      // bars
      const step = px / PEAKS_PER_SECOND;
      const barW = Math.max(1, step - 1.5);
      if (peaks) {
        const first = Math.max(0, Math.floor(time * PEAKS_PER_SECOND - headX / step) - 1);
        const lastIdx = Math.min(
          peaks.length - 1,
          Math.ceil(time * PEAKS_PER_SECOND + (w - headX) / step) + 1,
        );
        for (let i = first; i <= lastIdx; i++) {
          const x = headX + (i / PEAKS_PER_SECOND - time) * px;
          const bh = Math.max(2, peaks[i]! * plot * 0.78);
          ctx.fillStyle = x <= headX ? col.lit : col.dim;
          ctx.fillRect(Math.round(x), Math.round(mid - bh / 2), barW, Math.round(bh));
        }
      }

      // ruler
      ctx.fillStyle = col.hair;
      ctx.fillRect(0, plot, w, 1);
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.textBaseline = "top";
      ctx.fillStyle = col.muted;
      const t0 = Math.floor(time - headX / px);
      for (let s = t0; s <= time + (w - headX) / px + 1; s++) {
        if (s < 0 || (duration && s > duration)) continue;
        const x = Math.round(headX + (s - time) * px);
        ctx.fillStyle = col.hair;
        ctx.fillRect(x, plot, 1, s % 2 === 0 ? 6 : 3);
        if (s % 2 === 0) {
          ctx.fillStyle = col.muted;
          ctx.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, x + 4, plot + 8);
        }
      }

      // playhead
      ctx.fillStyle = col.lit;
      ctx.fillRect(Math.round(headX), 0, 1, plot);
      ctx.fillRect(Math.round(headX) - 2, 0, 5, 5);
    },
    [peaks, duration],
  );

  // Size the backing store to the element (and device pixel ratio), then redraw.
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      size.current = { w: r.width, h: r.height };
      draw(last.current);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, [draw]);

  // Colours come from the theme's CSS variables; refresh them (before paint) whenever the theme changes.
  useLayoutEffect(() => {
    if (canvas.current) colors.current = readColors(canvas.current);
    draw(last.current);
  }, [theme, draw]);

  useEffect(() => {
    handleRef.current = {
      draw,
      pxPerSecond: () => size.current.w / WINDOW_SECONDS,
      playheadX: () => size.current.w * PLAYHEAD,
    };
    return () => {
      handleRef.current = null;
    };
  }, [draw, handleRef]);

  return <canvas ref={canvas} aria-hidden="true" className={className} />;
}
