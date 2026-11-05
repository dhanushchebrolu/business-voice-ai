import { Check, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Logo } from "@/components/app/primitives";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "./primitives";
import { DEMO_CALL, type RecordedCall } from "./voice-demo-data";

/**
 * Recorded-call player: header, real waveform, transcript and action steps.
 * The waveform is the decoded audio itself (peak per bar), not decoration. When
 * `call.synced` is true the transcript follows the audio (active line, speaker,
 * auto-scroll, click-to-seek) and action steps tick off as playback passes their
 * timestamps. When false (placeholder audio) the transcript is a labelled preview
 * with no sync. Never autoplays; pauses and releases the audio on unmount.
 */

const BARS = 72;
const SEEK_STEP = 5;

const fmt = (s: number) =>
  Number.isFinite(s) && s > 0
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
    : "0:00";

/** Peak amplitude per bar, 0..1, from the decoded audio file. Stays null while loading or if it can't be decoded. */
function usePeaks(src: string): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    let dead = false;
    setPeaks(null);
    fetch(src)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf))
      .then((decoded) => {
        const ch = decoded.getChannelData(0);
        const size = Math.max(1, Math.floor(ch.length / BARS));
        const raw = Array.from({ length: BARS }, (_, i) => {
          let max = 0;
          for (let j = i * size; j < Math.min(ch.length, (i + 1) * size); j += 8) {
            max = Math.max(max, Math.abs(ch[j] ?? 0));
          }
          return max;
        });
        const top = Math.max(...raw, 0.0001);
        if (!dead) setPeaks(raw.map((v) => Math.max(0.06, v / top)));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [src]);
  return peaks;
}

export function VoicePlayer({ call = DEMO_CALL }: { call?: RecordedCall }) {
  const audio = useRef<HTMLAudioElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const raf = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [sec, setSec] = useState(0);
  const [active, setActive] = useState(-1);
  const peaks = usePeaks(call.src);
  const { synced, segments, actions } = call;

  const sync = useCallback(() => {
    const a = audio.current;
    if (!a) return;
    const t = a.currentTime;
    wave.current?.style.setProperty("--p", `${a.duration ? (t / a.duration) * 100 : 0}%`);
    setSec(Math.floor(t));
    if (synced) {
      let idx = -1;
      segments.forEach((s, i) => {
        if (t >= s.start) idx = i;
      });
      setActive(idx);
    }
  }, [synced, segments]);

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      sync();
      raf.current = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf.current);
  }, [playing, sync]);

  // Metadata can arrive before hydration, so read it once on mount; release the audio on unmount.
  useEffect(() => {
    const a = audio.current;
    if (a && a.readyState > 0) setDuration(a.duration);
    return () => {
      if (!a) return;
      a.pause();
      a.removeAttribute("src");
      a.load();
    };
  }, []);

  // Keep the active line centred inside the transcript box only (never scrolls the page).
  useEffect(() => {
    const box = list.current;
    const el = box?.children[active] as HTMLElement | undefined;
    if (!synced || !box || !el) return;
    const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [active, synced]);

  async function toggle() {
    const a = audio.current;
    if (!a) return;
    if (!a.paused) return a.pause();
    setFailed(false);
    try {
      await a.play();
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") setFailed(true);
    }
  }

  function seekTo(t: number, thenPlay = false) {
    const a = audio.current;
    if (!a || !duration) return;
    a.currentTime = Math.min(Math.max(0, t), duration);
    sync();
    if (thenPlay && a.paused) void toggle();
  }

  function seekFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * duration);
  }

  function onWaveKey(e: React.KeyboardEvent) {
    const a = audio.current;
    if (!a) return;
    const to: Record<string, number> = {
      ArrowRight: a.currentTime + SEEK_STEP,
      ArrowUp: a.currentTime + SEEK_STEP,
      ArrowLeft: a.currentTime - SEEK_STEP,
      ArrowDown: a.currentTime - SEEK_STEP,
      Home: 0,
      End: duration,
    };
    if (e.key in to) {
      e.preventDefault();
      seekTo(to[e.key]!);
    }
  }

  const bars = useMemo(() => {
    const total = duration || segments.at(-1)?.end || 1;
    return (peaks ?? Array.from({ length: BARS }, () => 0.08)).map((h, i) => {
      const t = ((i + 0.5) / BARS) * total;
      const seg = synced ? segments.find((s) => t >= s.start && t < s.end) : undefined;
      return { h, agent: !synced || seg?.speaker === "agent" };
    });
  }, [peaks, duration, synced, segments]);

  const state = failed
    ? "Couldn't load the recording"
    : buffering
      ? "Buffering…"
      : playing
        ? "Playing"
        : !duration
          ? "Loading…"
          : sec > 0
            ? "Paused"
            : "Ready";
  const speaking = synced && playing && active >= 0 ? segments[active] : undefined;

  return (
    <div className="border border-[var(--vx-hair)] bg-[var(--vx-card)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--vx-hair)] px-5 py-4">
        <div>
          <Logo className="[&_img]:h-6" />
          <p className="mt-3 font-display text-[18px] leading-tight text-[var(--vx-ink)]">
            {call.title}
          </p>
          <p className="mt-0.5 font-vmono text-[11px] uppercase tracking-[0.1em] text-[var(--vx-muted)]">
            {call.callType} · {duration ? fmt(duration) : "--:--"}
          </p>
        </div>
        <span className="mt-1 shrink-0 border border-[var(--vx-hair)] px-2 py-1 font-vmono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--vx-muted)]">
          {synced ? "Recorded call" : "Placeholder audio"}
        </span>
      </div>

      <div className="px-5 pt-5">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={toggle}
            disabled={failed}
            aria-label={playing ? "Pause call recording" : "Play call recording"}
            className="grid size-14 shrink-0 place-items-center rounded-full bg-[var(--vx-btn)] text-white transition-colors hover:bg-[var(--vx-accent-hot)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)] disabled:opacity-50"
          >
            {playing ? (
              <Pause className="size-5" aria-hidden="true" />
            ) : (
              <Play className="ml-0.5 size-5" aria-hidden="true" />
            )}
          </button>
          <div
            ref={wave}
            role="slider"
            tabIndex={0}
            aria-label="Recording position"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={sec}
            aria-valuetext={`${fmt(sec)} of ${fmt(duration)}`}
            aria-disabled={!duration}
            onKeyDown={onWaveKey}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              seekFromPointer(e);
            }}
            onPointerMove={(e) => e.buttons === 1 && seekFromPointer(e)}
            className="relative h-16 min-w-0 flex-1 cursor-pointer touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--vx-accent)]"
            style={{ "--p": "0%" } as React.CSSProperties}
          >
            <div aria-hidden="true" className="absolute inset-0 flex items-center gap-[2px]">
              {bars.map((b, i) => (
                <span
                  key={i}
                  className="flex-1 bg-[var(--vx-faint)]"
                  style={{ height: `${Math.round(b.h * 100)}%` }}
                />
              ))}
            </div>
            <div
              aria-hidden="true"
              className="absolute inset-0 flex items-center gap-[2px]"
              style={{ clipPath: "inset(0 calc(100% - var(--p)) 0 0)" }}
            >
              {bars.map((b, i) => (
                <span
                  key={i}
                  className={cn("flex-1", b.agent ? "bg-[var(--vx-accent)]" : "bg-[var(--vx-ink)]")}
                  style={{ height: `${Math.round(b.h * 100)}%` }}
                />
              ))}
            </div>
            <span
              aria-hidden="true"
              className="absolute inset-y-0 w-px bg-[var(--vx-ink)]"
              style={{ left: "var(--p)" }}
            />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between pl-[72px] font-vmono text-[11px] tabular-nums text-[var(--vx-muted)]">
          <span>{fmt(sec)}</span>
          <span role="status" aria-live="polite">
            {state}
            {failed ? (
              <button
                type="button"
                onClick={() => {
                  setFailed(false);
                  audio.current?.load();
                }}
                className="ml-2 inline-flex items-center gap-1 underline underline-offset-2"
              >
                <RotateCcw className="size-3" aria-hidden="true" /> Retry
              </button>
            ) : null}
          </span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      <audio
        ref={audio}
        src={call.src}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onPlaying={() => {
          setPlaying(true);
          setBuffering(false);
        }}
        onPause={() => {
          setPlaying(false);
          sync();
        }}
        onWaiting={() => setBuffering(true)}
        onCanPlay={() => setBuffering(false)}
        onSeeked={sync}
        onEnded={() => {
          setPlaying(false);
          if (audio.current) audio.current.currentTime = 0;
          sync();
        }}
        onError={() => {
          setFailed(true);
          setPlaying(false);
        }}
      />

      <div className="mt-5 border-t border-[var(--vx-hair)] px-5 pt-4">
        <div className="flex items-center justify-between gap-3 font-vmono text-[10px] uppercase tracking-[0.12em] text-[var(--vx-muted)]">
          <span>{synced ? "Transcript" : "Sample script"}</span>
          {speaking ? (
            <span className="flex items-center gap-2 text-[var(--vx-ink)]">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  speaking.speaker === "agent" ? "bg-[var(--vx-accent)]" : "bg-[var(--vx-ink)]",
                )}
              />
              {speaking.speaker === "agent" ? "AI Receptionist speaking" : "Caller speaking"}
            </span>
          ) : null}
        </div>
        {!synced ? (
          <p className="mt-2 font-vmono text-[11px] leading-[1.6] text-[var(--vx-muted)]">
            The audio is placeholder tones while the recorded call is prepared. This script is not
            synced to it.
          </p>
        ) : null}
        <ol ref={list} className="relative mt-3 max-h-[188px] space-y-1 overflow-y-auto pr-1">
          {segments.map((s, i) => {
            const on = synced && i === active;
            const body = (
              <>
                <span className="block font-vmono text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--vx-muted)]">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mr-2 inline-block size-1.5 align-middle",
                      s.speaker === "agent" ? "bg-[var(--vx-accent)]" : "bg-[var(--vx-faint)]",
                    )}
                  />
                  {s.speaker === "agent" ? "AI Receptionist" : "Caller"}
                </span>
                <span className="mt-1 block font-display text-[15px] leading-[1.4]">{s.text}</span>
              </>
            );
            const base = cn(
              "block w-full border-l-2 py-2 pl-3 text-left transition-colors",
              on ? "border-[var(--vx-accent)]" : "border-transparent",
              !synced || on ? "text-[var(--vx-ink)]" : "text-[var(--vx-muted)]",
            );
            return (
              <li key={s.id} aria-current={on ? "true" : undefined}>
                {synced ? (
                  <button
                    type="button"
                    onClick={() => seekTo(s.start, true)}
                    className={cn(
                      base,
                      "hover:text-[var(--vx-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--vx-accent)]",
                    )}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={base}>{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="mt-4 border-t border-[var(--vx-hair)] px-5 py-4">
        <p className="font-vmono text-[10px] uppercase tracking-[0.12em] text-[var(--vx-muted)]">
          {synced ? "What the AI did on this call" : "What the AI handles in this scenario"}
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
          {actions.map((a) => {
            const done = synced && sec >= a.at && (playing || sec > 0);
            return (
              <li
                key={a.label}
                className={cn(
                  "flex items-center gap-2 font-vmono text-[12px]",
                  done ? "text-[var(--vx-ink)]" : "text-[var(--vx-muted)]",
                )}
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center border",
                    done
                      ? "border-[var(--vx-accent)] bg-[var(--vx-accent)] text-white"
                      : "border-[var(--vx-hair)]",
                  )}
                >
                  {done ? <Check className="size-3" aria-hidden="true" /> : null}
                </span>
                {a.label}
                {done ? <span className="sr-only"> (done)</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
