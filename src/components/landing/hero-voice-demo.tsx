import { useEffect, useRef, useState } from "react";
import { Mic, Pause, RotateCcw } from "lucide-react";
import { ParticleWave } from "./particle-wave";

/**
 * The hero's right-side audio player — the one place on the homepage a
 * visitor can actually press play and hear a sample AI conversation,
 * exactly as requested. Reuses the same real Web Audio API engine as
 * voice-demo.tsx (genuine play/pause/seek against a real <audio> element,
 * a real AnalyserNode driving the live waveform — never a fake/animated-
 * only "player"), restyled as the hero's centerpiece: a large circular
 * control over a full-bleed ParticleWave backdrop instead of a compact
 * card with inline bars.
 *
 * AUDIO SOURCE: plays /audio/ai-receptionist-demo.mp3 — replace that file
 * with a real recorded call and this player picks it up with no code
 * changes (duration/progress/waveform all derive from the file itself).
 *
 * Deliberately has NO transcript/captions: unlike voice-demo.tsx's compact
 * card (whose two-line script is hand-timed to its own bundled track),
 * this player is meant to work with whatever audio file is dropped in —
 * fabricated captions would drift out of sync the moment the file changes.
 */
export function HeroVoiceDemo() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      audioContextRef.current?.close().catch(() => {});
    };
  }, []);

  function ensureAnalyser() {
    const audio = audioRef.current;
    if (!audio || analyserRef.current) return;
    try {
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
    } catch {
      // Web Audio API unavailable or blocked — playback still works via the
      // plain <audio> element; only the live-reactive wave is skipped.
    }
  }

  function tick() {
    const analyser = analyserRef.current;
    const audio = audioRef.current;
    if (!audio) return;
    if (analyser) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length / 255;
      setAmplitude(avg);
    }
    setCurrentTime(audio.currentTime);
    rafRef.current = requestAnimationFrame(tick);
  }

  async function handlePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    setError(null);
    if (isPlaying) {
      audio.pause();
      return;
    }
    ensureAnalyser();
    if (audioContextRef.current?.state === "suspended") {
      await audioContextRef.current.resume().catch(() => {});
    }
    try {
      await audio.play();
    } catch {
      setError("Couldn't start playback. Please try again.");
    }
  }

  function handleReplay() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    setCurrentTime(0);
    if (!isPlaying) void handlePlayPause();
  }

  function handleSeek(clientX: number) {
    const audio = audioRef.current;
    const track = progressRef.current;
    if (!audio || !track || !Number.isFinite(duration) || duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = fraction * duration;
    setCurrentTime(audio.currentTime);
  }

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  const progressFraction = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="relative mx-auto w-full max-w-md">
      <div
        className="pointer-events-none absolute -right-10 -top-10 h-56 w-56 rounded-full bg-violet-300/50 blur-[90px]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-10 -left-10 h-56 w-56 rounded-full bg-sky-200/60 blur-[90px]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute right-10 bottom-0 h-40 w-40 rounded-full bg-fuchsia-200/50 blur-[80px]"
        aria-hidden="true"
      />

      <p className="relative mb-3 text-right text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">
        Try it out
      </p>

      <div className="relative overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-[0_30px_60px_-25px_rgba(124,58,237,0.35)]">
        <div className="pointer-events-none absolute inset-0 opacity-80">
          <ParticleWave
            tone="on-light"
            variant="hero"
            amplitude={amplitude}
            className="h-full w-full"
          />
        </div>

        <audio
          ref={audioRef}
          src="/audio/ai-receptionist-demo.mp3"
          preload="none"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onPlay={() => {
            setIsPlaying(true);
            rafRef.current = requestAnimationFrame(tick);
          }}
          onPause={() => {
            setIsPlaying(false);
            cancelAnimationFrame(rafRef.current);
          }}
          onEnded={() => {
            setIsPlaying(false);
            cancelAnimationFrame(rafRef.current);
            setAmplitude(0);
          }}
          onError={() => setError("This demo audio couldn't be loaded.")}
        />

        <div className="relative flex flex-col items-center px-8 py-16 sm:py-20">
          <button
            type="button"
            onClick={handlePlayPause}
            aria-label={isPlaying ? "Pause the demo call" : "Play the demo call"}
            className="group relative grid size-28 shrink-0 place-items-center rounded-full bg-white shadow-[0_18px_40px_-12px_rgba(124,58,237,0.55)] transition-transform hover:scale-105 sm:size-32"
          >
            <span
              className="absolute inset-0 rounded-full bg-[conic-gradient(from_180deg,theme(colors.violet.400),theme(colors.sky.300),theme(colors.fuchsia.300),theme(colors.violet.400))] opacity-90"
              aria-hidden="true"
            />
            <span
              className="absolute inset-[5px] rounded-full bg-white"
              aria-hidden="true"
              style={{
                transform: isPlaying ? `scale(${1 - Math.min(amplitude, 1) * 0.08})` : undefined,
              }}
            />
            {isPlaying ? (
              <Pause className="relative size-9 fill-violet-600 text-violet-600" />
            ) : (
              <Mic className="relative size-9 text-violet-600" />
            )}
          </button>

          <div className="mt-8 w-full max-w-[260px]">
            <div
              ref={progressRef}
              className="relative h-1.5 w-full cursor-pointer rounded-full bg-slate-200"
              role="slider"
              aria-label="Seek demo audio"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(currentTime)}
              tabIndex={0}
              onClick={(e) => handleSeek(e.clientX)}
              onKeyDown={(e) => {
                const audio = audioRef.current;
                if (!audio) return;
                if (e.key === "ArrowRight")
                  audio.currentTime = Math.min(duration, audio.currentTime + 5);
                if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
              }}
            >
              <div
                className="h-full rounded-full bg-violet-600"
                style={{ width: `${Math.round(progressFraction * 100)}%` }}
              />
            </div>
            <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-400">
              <span className="font-mono tabular-nums">{formatTime(currentTime)}</span>
              <button
                type="button"
                onClick={handleReplay}
                aria-label="Replay demo"
                className="flex items-center gap-1 text-slate-400 transition-colors hover:text-violet-600"
              >
                <RotateCcw className="size-3" /> Replay
              </button>
              <span className="font-mono tabular-nums">{formatTime(duration)}</span>
            </div>
          </div>

          {error ? <p className="mt-3 text-[11px] text-red-600">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
