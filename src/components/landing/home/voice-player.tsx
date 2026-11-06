import { Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { CallScope, PEAKS_PER_SECOND, type ScopeHandle } from "./call-scope";
import { prefersReducedMotion } from "./primitives";
import { useVxTheme } from "./theme";
import { DEMO_CALLS, type RecordedCall } from "./voice-demo-data";

/**
 * Recorded-call player in the style of a call scope: a scrolling waveform under a
 * fixed playhead, the transcript beneath it, one transport button. Everything is
 * driven by the recording in `call` (see voice-demo-data.ts): the waveform is the
 * decoded audio, the active line follows the segment timestamps, a click on a line
 * or on the scope seeks. With no `call.src` it shows a recording-pending state and
 * the sample script, with nothing that moves or syncs. Never autoplays; pauses and
 * releases the audio on unmount.
 */

const SEEK_STEP = 5;
const MANUAL_SCROLL_HOLD_MS = 4000;

const fmt = (s: number) =>
  Number.isFinite(s) && s > 0
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
    : "0:00";

/** Peak amplitude (0..1) at PEAKS_PER_SECOND, from the decoded audio file. Null until decoded, or if it can't be. */
function usePeaks(src: string | null): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    setPeaks(null);
    if (!src) return;
    let dead = false;
    fetch(src)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf))
      .then((decoded) => {
        const ch = decoded.getChannelData(0);
        const size = Math.max(1, Math.floor(decoded.sampleRate / PEAKS_PER_SECOND));
        const n = Math.ceil(ch.length / size);
        const raw = Array.from({ length: n }, (_, i) => {
          let max = 0;
          for (let j = i * size; j < Math.min(ch.length, (i + 1) * size); j += 4) {
            max = Math.max(max, Math.abs(ch[j] ?? 0));
          }
          return max;
        });
        const top = Math.max(...raw, 0.0001);
        if (!dead) setPeaks(raw.map((v) => Math.max(0.04, v / top)));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [src]);
  return peaks;
}

export function VoicePlayer({ calls = DEMO_CALLS }: { calls?: RecordedCall[] }) {
  const [langId, setLangId] = useState(calls[0]!.id);
  const call = calls.find((c) => c.id === langId) ?? calls[0]!;
  const { src, segments } = call;
  const pending = src === null;
  const theme = useVxTheme();
  const audio = useRef<HTMLAudioElement>(null);
  const scope = useRef<ScopeHandle | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const raf = useRef(0);
  const dragging = useRef(false);
  const lastManualScroll = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [sec, setSec] = useState(0);
  const [active, setActive] = useState(-1);
  const peaks = usePeaks(src);

  const sync = useCallback(() => {
    const a = audio.current;
    if (!a) return;
    scope.current?.draw(a.currentTime);
    setSec(Math.floor(a.currentTime));
    let idx = -1;
    segments.forEach((s, i) => {
      if (s.start !== undefined && a.currentTime >= s.start) idx = i;
    });
    setActive(idx);
  }, [segments]);

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      sync();
      raf.current = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf.current);
  }, [playing, sync]);

  // Redraw once when peaks or duration arrive (the loop is idle while paused).
  useEffect(() => {
    sync();
  }, [peaks, duration, sync]);

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

  // Follow the active line inside the transcript box only, and never while the visitor is scrolling it themselves.
  useEffect(() => {
    const box = list.current;
    const el = box?.children[active] as HTMLElement | undefined;
    if (!box || !el || Date.now() - lastManualScroll.current < MANUAL_SCROLL_HOLD_MS) return;
    const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [active]);

  // One shared audio element: stop it, rewind it and clear every per-recording state before the new source loads.
  function selectLanguage(id: string) {
    if (id === call.id) return;
    const a = audio.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    setPlaying(false);
    setBuffering(false);
    setFailed(false);
    setDuration(0);
    setSec(0);
    setActive(-1);
    if (list.current) list.current.scrollTop = 0;
    setLangId(id);
  }

  async function toggle() {
    const a = audio.current;
    if (!a || pending) return;
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
    lastManualScroll.current = 0;
    sync();
    if (thenPlay && a.paused) void toggle();
  }

  // Scope: drag scrubs (the waveform follows the pointer), a click without movement jumps to the clicked time.
  const press = useRef({ x: 0, t: 0, moved: false });
  function onScopeDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!duration || !audio.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.clientX, t: audio.current.currentTime, moved: false };
    dragging.current = true;
  }
  function onScopeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const px = scope.current?.pxPerSecond() ?? 1;
    const dx = e.clientX - press.current.x;
    if (Math.abs(dx) > 4) press.current.moved = true;
    if (press.current.moved) seekTo(press.current.t - dx / px);
  }
  function onScopeUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    if (!press.current.moved && scope.current) {
      const r = e.currentTarget.getBoundingClientRect();
      const px = scope.current.pxPerSecond();
      seekTo(press.current.t + (e.clientX - r.left - scope.current.playheadX()) / px);
    }
  }
  function onScopeKey(e: React.KeyboardEvent) {
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
    } else if (e.key === " ") {
      e.preventDefault();
      void toggle();
    }
  }

  const state = pending
    ? "Recording coming soon"
    : failed
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
  const speaking = playing && active >= 0 ? segments[active] : undefined;
  const nameOf = (s: "customer" | "agent") => (s === "agent" ? "AI Receptionist" : "Customer");

  return (
    <div className="border border-[var(--vx-hair)] bg-[var(--vx-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--vx-hair)] px-4 py-2.5 font-vmono text-[12px]">
        <span className="flex min-w-0 items-center gap-2 truncate whitespace-nowrap text-[var(--vx-ink)]">
          <span aria-hidden="true" className="size-1.5 bg-[var(--vx-accent)]" />
          clickai / {call.title.toLowerCase().replace(/\s+/g, "-")}
        </span>
        <span className="shrink-0 whitespace-nowrap text-[var(--vx-muted)]">
          [{pending ? "recording pending" : "recorded call"}]
        </span>
      </div>

      {calls.length > 1 ? (
        <div
          role="group"
          aria-label="Call language"
          className="flex flex-wrap items-center gap-1.5 border-b border-[var(--vx-hair)] px-4 py-2"
        >
          {calls.map((c) => (
            <button
              key={c.id}
              type="button"
              lang={c.lang}
              aria-label={c.name}
              aria-pressed={c.id === call.id}
              onClick={() => selectLanguage(c.id)}
              className={cn(
                "h-7 rounded-full border px-3 font-vmono text-[12px] transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)]",
                c.id === call.id
                  ? "border-[var(--vx-accent)] bg-[var(--vx-btn)] text-white"
                  : "border-[var(--vx-hair)] text-[var(--vx-muted)] hover:border-[var(--vx-accent)] hover:text-[var(--vx-ink)]",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}

      <div
        role="slider"
        tabIndex={pending ? -1 : 0}
        aria-label="Recording position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={sec}
        aria-valuetext={pending ? "No recording yet" : `${fmt(sec)} of ${fmt(duration)}`}
        aria-disabled={pending || !duration}
        onKeyDown={onScopeKey}
        onPointerDown={onScopeDown}
        onPointerMove={onScopeMove}
        onPointerUp={onScopeUp}
        onPointerCancel={() => (dragging.current = false)}
        className={cn(
          "relative h-[172px] touch-pan-y bg-[var(--vx-alt)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--vx-accent)] sm:h-[188px]",
          duration ? "cursor-ew-resize" : "cursor-default",
        )}
      >
        <CallScope
          peaks={peaks}
          duration={duration}
          theme={theme}
          handleRef={scope}
          className="absolute inset-0 size-full"
        />
        <button
          type="button"
          onClick={toggle}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={pending || failed}
          aria-label={
            pending
              ? "Recording coming soon"
              : playing
                ? "Pause call recording"
                : "Play call recording"
          }
          className={cn(
            "absolute grid size-14 place-items-center rounded-full bg-[var(--vx-btn)] text-white transition-[transform,background-color] duration-300 hover:bg-[var(--vx-accent-hot)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vx-accent)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none",
            playing
              ? "bottom-3 right-3 scale-[0.72]"
              : "left-1/2 top-[calc(50%-11px)] -translate-x-1/2 -translate-y-1/2",
          )}
        >
          <Play
            className={cn(
              "absolute ml-0.5 size-5 transition-[transform,opacity] duration-200 motion-reduce:transition-none",
              playing ? "scale-50 opacity-0" : "scale-100 opacity-100",
            )}
            aria-hidden="true"
          />
          <Pause
            className={cn(
              "absolute size-5 transition-[transform,opacity] duration-200 motion-reduce:transition-none",
              playing ? "scale-100 opacity-100" : "scale-50 opacity-0",
            )}
            aria-hidden="true"
          />
        </button>
        {!playing ? (
          <span className="pointer-events-none absolute left-1/2 top-[calc(50%+34px)] -translate-x-1/2 whitespace-nowrap border border-[var(--vx-hair)] bg-[var(--vx-card)] px-2 py-0.5 font-vmono text-[11px] text-[var(--vx-ink)]">
            {pending ? "Recording coming soon" : failed ? "Couldn't load" : "Listen to the call"}
          </span>
        ) : null}
      </div>

      {src ? (
        <audio
          ref={audio}
          src={src}
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
      ) : null}

      <div className="border-t border-[var(--vx-hair)] px-4 py-3">
        {segments.length === 0 ? (
          <p className="py-2 font-vmono text-[12px] leading-[1.6] text-[var(--vx-muted)]">
            Transcript for this recording is coming soon.
          </p>
        ) : null}
        <ol
          ref={list}
          aria-label="Transcript"
          onWheel={() => (lastManualScroll.current = Date.now())}
          onTouchMove={() => (lastManualScroll.current = Date.now())}
          hidden={segments.length === 0}
          className="relative max-h-[132px] space-y-0.5 overflow-y-auto overscroll-contain pr-1"
        >
          {segments.map((s, i) => {
            const on = i === active;
            const seekable = !pending && s.start !== undefined;
            const body = (
              <>
                <span
                  className={cn(
                    "mr-2 font-vmono text-[11px] lowercase",
                    s.speaker === "agent"
                      ? "text-[var(--vx-accent-hot)]"
                      : "text-[var(--vx-muted)]",
                  )}
                >
                  {s.speaker === "agent" ? "agent" : "customer"} ›
                </span>
                <span className="font-display text-[15px] leading-[1.45]">{s.text}</span>
                <span className="sr-only"> ({nameOf(s.speaker)})</span>
              </>
            );
            const base = cn(
              "block w-full border-l-2 py-1.5 pl-3 text-left transition-colors motion-reduce:transition-none",
              on ? "border-[var(--vx-accent)] text-[var(--vx-ink)]" : "border-transparent",
              pending || on ? "" : "text-[var(--vx-muted)]",
              pending ? "text-[var(--vx-ink)]" : "",
            );
            return (
              <li key={s.id} aria-current={on ? "true" : undefined}>
                {seekable ? (
                  <button
                    type="button"
                    onClick={() => seekTo(s.start!, true)}
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

      <div className="flex items-center justify-between gap-3 border-t border-[var(--vx-hair)] px-4 py-2 font-vmono text-[11px] tabular-nums text-[var(--vx-muted)]">
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
        <span className="flex items-center gap-3">
          {speaking ? (
            <span className="text-[var(--vx-ink)]">{nameOf(speaking.speaker)} speaking</span>
          ) : null}
          <span>{pending ? "no recording" : `${fmt(sec)} / ${fmt(duration)}`}</span>
        </span>
      </div>
    </div>
  );
}
