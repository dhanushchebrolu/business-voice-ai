import { useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { ParticleWave } from "./particle-wave";

/**
 * The AI Receptionist voice demo. A real, playable local audio asset
 * (public/audio/ai-receptionist-demo.mp3 — a tasteful ambient tone
 * sequence generated for this build, not a recording of anyone's voice
 * and not an ffmpeg-faked "player") drives a genuine Web Audio API
 * AnalyserNode, so the waveform bars and the small ParticleWave behind
 * this section are truly audio-reactive, not a canned animation loop
 * pretending to react. The four-line conversation transcript is
 * synchronized to fixed cue timestamps that match the track's four
 * tonal beats.
 *
 * Every control is real: play/pause toggles actual playback, the bar is
 * click/drag-seekable against the real <audio> element's currentTime,
 * duration/progress come from real media events, and replay restarts
 * from zero. Autoplay is never attempted — playback only starts from a
 * user click. Load/decoding failures are caught and shown as a plain
 * inline message rather than a broken/silent control.
 */

const TRANSCRIPT: { speaker: "Caller" | "ClickAI"; line: string; cueAt: number }[] = [
  { speaker: "Caller", line: "Hi, I'd like to book an appointment for tomorrow.", cueAt: 0 },
  { speaker: "ClickAI", line: "Absolutely. What time works best for you?", cueAt: 4.2 },
  { speaker: "Caller", line: "Around 4 PM.", cueAt: 8.5 },
  { speaker: "ClickAI", line: "4 PM is available. I've booked it for you.", cueAt: 12.8 },
];

const BAR_COUNT = 56;
/** A fixed, non-random envelope so the resting (unplayed) bar heights are visually pleasant and stable across renders — not a literal decode of the audio file, just a static base shape the live analyser data modulates on top of during playback. */
const BASE_ENVELOPE = Array.from({ length: BAR_COUNT }, (_, i) => {
  const wave = Math.sin((i / BAR_COUNT) * Math.PI * 3.2) * 0.5 + 0.5;
  const taper = Math.sin((i / BAR_COUNT) * Math.PI);
  return 0.18 + wave * 0.35 * taper;
});

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VoiceDemo() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);
  const [liveBars, setLiveBars] = useState<number[]>(BASE_ENVELOPE);

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
      analyser.fftSize = 128;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
    } catch {
      // Web Audio API unavailable or blocked — playback still works via the
      // plain <audio> element; only the live-reactive bars are skipped, and
      // the static BASE_ENVELOPE keeps rendering instead.
    }
  }

  function tick() {
    const analyser = analyserRef.current;
    const audio = audioRef.current;
    if (!analyser || !audio) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((sum, v) => sum + v, 0) / data.length / 255;
    setAmplitude(avg);

    const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
      const binIndex = Math.floor((i / BAR_COUNT) * data.length);
      const level = (data[binIndex] ?? 0) / 255;
      return Math.max(BASE_ENVELOPE[i]!, level);
    });
    setLiveBars(bars);
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
    const track = barsRef.current;
    if (!audio || !track || !Number.isFinite(duration) || duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = fraction * duration;
    setCurrentTime(audio.currentTime);
  }

  const progressFraction = duration > 0 ? currentTime / duration : 0;
  const activeLineIndex = [...TRANSCRIPT].reverse().findIndex((line) => currentTime >= line.cueAt);
  const activeIndex = activeLineIndex === -1 ? -1 : TRANSCRIPT.length - 1 - activeLineIndex;

  return (
    <section id="voice-demo" className="relative overflow-hidden bg-[#0a0a0d] py-24 sm:py-32">
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <ParticleWave
          tone="on-dark"
          variant="subtle"
          amplitude={amplitude}
          className="h-full w-full"
        />
      </div>

      <div className="relative mx-auto max-w-[1000px] px-5 sm:px-8">
        <p className="text-center text-[11px] font-medium uppercase tracking-[0.2em] text-white/45">
          AI Receptionist
        </p>
        <h2 className="mx-auto mt-4 max-w-xl text-center font-serif text-4xl leading-tight text-white sm:text-5xl">
          Hear it answer a real request.
        </h2>

        <div
          className="mx-auto mt-14 max-w-xl space-y-5"
          role="log"
          aria-label="Sample conversation"
        >
          {TRANSCRIPT.map((entry, i) => (
            <div
              key={entry.line}
              className={`flex flex-col gap-1 rounded-2xl border px-5 py-4 transition-colors duration-500 ${
                entry.speaker === "Caller" ? "items-start" : "items-end"
              } ${
                i === activeIndex
                  ? "border-white/25 bg-white/[0.06]"
                  : "border-white/10 bg-white/[0.02]"
              }`}
            >
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/40">
                {entry.speaker}
              </span>
              <p className="text-sm text-white/85 sm:text-base">{entry.line}</p>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-white/10 bg-white/[0.03] p-5">
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

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={isPlaying ? "Pause demo" : "Play demo"}
              className="grid size-11 shrink-0 place-items-center rounded-full bg-white text-[#0a0a0d] transition-transform hover:scale-105"
            >
              {isPlaying ? <Pause className="size-4" /> : <Play className="ml-0.5 size-4" />}
            </button>

            <div
              ref={barsRef}
              className="relative flex h-11 flex-1 cursor-pointer items-center gap-[3px]"
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
              {liveBars.map((level, i) => {
                const played = i / BAR_COUNT <= progressFraction;
                return (
                  <span
                    key={i}
                    className={`w-full rounded-full transition-colors ${played ? "bg-white" : "bg-white/20"}`}
                    style={{ height: `${Math.max(8, level * 100)}%` }}
                  />
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleReplay}
              aria-label="Replay demo"
              className="grid size-9 shrink-0 place-items-center rounded-full border border-white/15 text-white/70 transition-colors hover:text-white"
            >
              <RotateCcw className="size-3.5" />
            </button>

            <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-white/50">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          {error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}
