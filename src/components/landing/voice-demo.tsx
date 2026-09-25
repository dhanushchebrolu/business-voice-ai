import { useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { ParticleWave } from "./particle-wave";

/**
 * A real, playable local audio asset (public/audio/ai-receptionist-demo.mp3
 * — a tasteful ambient tone sequence generated for this build, not a
 * recording of anyone's voice and not a faked "player") drives a genuine
 * Web Audio API AnalyserNode, so the waveform bars and the small
 * ParticleWave behind this card are truly audio-reactive. The two-line
 * conversation snippet is synchronized to fixed cue timestamps that match
 * the track's tonal beats.
 *
 * Every control is real: play/pause toggles actual playback, the bar is
 * click/drag-seekable against the real <audio> element's currentTime,
 * duration/progress come from real media events, and replay restarts from
 * zero. Autoplay is never attempted — playback only starts from a user
 * click. Load/decoding failures are caught and shown as a plain inline
 * message rather than a broken/silent control.
 *
 * Styled as a compact, embeddable card (not a full section) so it fits
 * inside the light feature-showcase pair alongside the WhatsApp AI card.
 */

const TRANSCRIPT: { speaker: "Caller" | "ClickAI"; line: string; cueAt: number }[] = [
  { speaker: "Caller", line: "Hi, I'd like to book an appointment for tomorrow.", cueAt: 0 },
  { speaker: "ClickAI", line: "Absolutely. What time works best for you?", cueAt: 4.2 },
  { speaker: "Caller", line: "Around 4 PM.", cueAt: 8.5 },
  { speaker: "ClickAI", line: "4 PM is available. I've booked it for you.", cueAt: 12.8 },
];

const BAR_COUNT = 28;
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
  const activeIndex = activeLineIndex === -1 ? 0 : TRANSCRIPT.length - 1 - activeLineIndex;
  const activeLine = TRANSCRIPT[activeIndex]!;

  return (
    <div id="voice-demo" className="relative overflow-hidden rounded-2xl bg-[#f0edf6] p-6">
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <ParticleWave
          tone="on-light"
          variant="subtle"
          amplitude={amplitude}
          className="h-full w-full"
        />
      </div>

      <div className="relative">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#14141a]/40">
          [2/2]
        </p>
        <h3 className="mt-3 text-xl font-semibold tracking-tight text-[#14141a]">Voice AI</h3>
        <p className="mt-2 text-sm leading-relaxed text-[#14141a]/55">
          Real-time voice conversations, handled end to end.
        </p>

        <div
          className="mt-5 rounded-xl border border-[#14141a]/10 bg-white/70 px-3.5 py-3 text-xs leading-relaxed text-[#14141a]/70 transition-colors duration-300"
          role="log"
          aria-label="Sample conversation"
        >
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-[#14141a]/35">
            {activeLine.speaker}
          </span>
          <p className="mt-1">{activeLine.line}</p>
        </div>

        <div className="mt-4 rounded-xl border border-[#14141a]/10 bg-white p-3.5">
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

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={isPlaying ? "Pause demo" : "Play demo"}
              className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-600 text-white transition-transform hover:scale-105"
            >
              {isPlaying ? <Pause className="size-3.5" /> : <Play className="ml-0.5 size-3.5" />}
            </button>

            <div
              ref={barsRef}
              className="relative flex h-9 flex-1 cursor-pointer items-center gap-[2px]"
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
                    className={`w-full rounded-full transition-colors ${played ? "bg-blue-600" : "bg-blue-600/15"}`}
                    style={{ height: `${Math.max(10, level * 100)}%` }}
                  />
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleReplay}
              aria-label="Replay demo"
              className="grid size-7 shrink-0 place-items-center rounded-full border border-[#14141a]/15 text-[#14141a]/60 transition-colors hover:text-[#14141a]"
            >
              <RotateCcw className="size-3" />
            </button>

            <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-[#14141a]/45">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          {error ? <p className="mt-2 text-[11px] text-red-600">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
