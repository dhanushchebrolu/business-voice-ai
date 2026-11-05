import { Pause, Phone, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/app/primitives";
import { prefersReducedMotion } from "./primitives";

/**
 * Hero voice demo. A real <audio> element plays /audio/ai-receptionist-demo.mp3;
 * the waveform is driven by a Web Audio analyser on that same element, so it moves
 * only while sound is actually playing and falls back to a resting shape when
 * paused. Never autoplays. The bundled file is a PLACEHOLDER tone sequence, not a
 * voice recording, and the card says so; swap the file at SRC (and TRANSCRIPT cue
 * times) when the real recording exists.
 */

const SRC = "/audio/ai-receptionist-demo.mp3";
const BARS = 40;
const REST = Array.from(
  { length: BARS },
  (_, i) => Math.round((0.18 + 0.32 * Math.abs(Math.sin(i * 0.55))) * 100) / 100,
);

const TRANSCRIPT = [
  ["Caller", "Hi, I'd like to book an appointment for tomorrow.", 0],
  ["ClickAI", "Of course. What time works best for you?", 4.2],
  ["Caller", "Around 4 PM.", 8.5],
  ["ClickAI", "4 PM is free. I've booked it for you.", 12.8],
] as const;

const fmt = (s: number) =>
  Number.isFinite(s) && s > 0
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
    : "0:00";

export function VoicePlayer() {
  const audio = useRef<HTMLAudioElement>(null);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const ctx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const raf = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const paint = (levels: ArrayLike<number>) =>
    bars.current.forEach((b, i) => b && (b.style.transform = `scaleY(${levels[i] ?? 0.1})`));

  useEffect(() => {
    paint(REST);
    return () => {
      cancelAnimationFrame(raf.current);
      void ctx.current?.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(raf.current);
      paint(REST);
      return;
    }
    const data = new Uint8Array(analyser.current?.frequencyBinCount ?? 0);
    const tick = () => {
      const a = audio.current;
      if (a) setTime(a.currentTime);
      if (analyser.current && !prefersReducedMotion()) {
        analyser.current.getByteFrequencyData(data);
        const live = Array.from(
          { length: BARS },
          (_, i) => (data[Math.floor((i / BARS) * data.length * 0.7)] ?? 0) / 255,
        );
        // No signal (analyser blocked or silent): keep the resting shape instead of a flat line.
        paint(live.some((v) => v > 0) ? live.map((v) => Math.max(0.1, v)) : REST);
      }
      raf.current = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  async function toggle() {
    const a = audio.current;
    if (!a) return;
    if (!a.paused) return a.pause();
    try {
      if (!analyser.current) {
        const AC = window.AudioContext;
        if (AC) {
          ctx.current = new AC();
          const node = ctx.current.createAnalyser();
          node.fftSize = 128;
          ctx.current.createMediaElementSource(a).connect(node);
          node.connect(ctx.current.destination);
          analyser.current = node;
        }
      }
      await ctx.current?.resume();
      setState("loading");
      await a.play();
      setState("idle");
    } catch {
      setState("error");
    }
  }

  const active = TRANSCRIPT.reduce((n, [, , at], i) => (time >= at ? i : n), 0);
  const pct = duration ? (time / duration) * 100 : 0;

  return (
    <div className="border border-[var(--vx-hair)] bg-[var(--vx-card)] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <Logo className="[&_img]:h-7" />
        <span className="flex items-center gap-2 font-vmono text-[11px] uppercase tracking-[0.1em] text-[var(--vx-muted)]">
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${playing ? "bg-emerald-500" : "bg-[var(--vx-faint)]"}`}
          />
          {playing ? "Playing" : "Ready"}
        </span>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center bg-[var(--vx-alt)] text-[var(--vx-accent)]">
          <Phone className="size-5" aria-hidden="true" />
        </span>
        <div>
          <p className="font-display text-[18px] leading-tight text-[var(--vx-ink)]">
            AI Receptionist
          </p>
          <p className="font-vmono text-[11px] text-[var(--vx-muted)]">Answering a booking call</p>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-4">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause sample call" : "Play sample call"}
          className="grid size-12 shrink-0 place-items-center bg-[var(--vx-btn)] text-white transition-colors hover:bg-[var(--vx-accent-hot)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)]"
        >
          {playing ? (
            <Pause className="size-5" aria-hidden="true" />
          ) : (
            <Play className="size-5" aria-hidden="true" />
          )}
        </button>
        <div aria-hidden="true" className="flex h-12 flex-1 items-center gap-[3px]">
          {Array.from({ length: BARS }, (_, i) => (
            <span
              key={i}
              ref={(el) => {
                bars.current[i] = el;
              }}
              className={`h-full flex-1 origin-center bg-[var(--vx-ink)] ${(i / BARS) * 100 < pct ? "opacity-100" : "opacity-35"}`}
              style={{ transform: `scaleY(${REST[i]})` }}
            />
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 font-vmono text-[11px] tabular-nums text-[var(--vx-muted)]">
        <span>{fmt(time)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(time, duration || 0)}
          disabled={!duration}
          aria-label="Seek"
          aria-valuetext={`${fmt(time)} of ${fmt(duration)}`}
          onChange={(e) => {
            const a = audio.current;
            if (a) a.currentTime = Number(e.target.value);
            setTime(Number(e.target.value));
          }}
          className="h-6 flex-1 cursor-pointer accent-[var(--vx-accent)] disabled:cursor-not-allowed"
        />
        <span>{fmt(duration)}</span>
      </div>

      <audio
        ref={audio}
        src={SRC}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
        onError={() => setState("error")}
      />

      <p
        role="status"
        aria-live="polite"
        className="mt-3 min-h-4 font-vmono text-[11px] text-[var(--vx-muted)]"
      >
        {state === "error"
          ? "The sample audio could not be played. Please try again."
          : state === "loading"
            ? "Loading…"
            : ""}
      </p>

      <ol
        className="mt-3 space-y-2 border-t border-[var(--vx-hair)] pt-4"
        aria-label="Sample conversation"
      >
        {TRANSCRIPT.map(([who, line], i) => (
          <li
            key={line}
            aria-current={playing && i === active ? "true" : undefined}
            className={`flex gap-3 font-vmono text-[12px] leading-[1.5] transition-opacity ${
              playing && i !== active ? "opacity-45" : ""
            } ${who === "ClickAI" ? "text-[var(--vx-ink)]" : "text-[var(--vx-muted)]"}`}
          >
            <span className="w-14 shrink-0 text-[10px] uppercase tracking-[0.1em]">{who}</span>
            <span>{line}</span>
          </li>
        ))}
      </ol>

      <p className="mt-4 border border-dashed border-[var(--vx-hair)] px-3 py-2 font-vmono text-[10px] uppercase leading-[1.5] tracking-[0.08em] text-[var(--vx-muted)]">
        Placeholder audio (tones). A recorded AI voice sample is still to be added. Script is
        illustrative.
      </p>
    </div>
  );
}
