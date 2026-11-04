import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Mic, RotateCcw, Send, Square } from "lucide-react";
import { publicChat } from "@/lib/public-assistant.functions";
import { BLOOP_PALETTES } from "@/components/orb/palettes";
import { cn } from "@/lib/utils";

/**
 * Hero assistant. Answers come from the real ClickAI website assistant
 * (`publicChat`, the same server function the floating chat widget uses), so
 * nothing here is scripted or pretended. Voice input/output use the visitor's
 * own browser (Web Speech API); this is NOT a phone call and not ClickAI's
 * production telephony pipeline. Where the browser has no speech support the
 * component is text-only.
 *
 * The WebGPU orb (SpaceUI OrbBloop, vendored in components/orb) is loaded
 * lazily and only when the browser exposes WebGPU and motion is allowed;
 * otherwise a static CSS orb with the same state ring is shown.
 */

const OrbBloop = lazy(() =>
  import("@/components/orb/orb-bloop").then((m) => ({ default: m.OrbBloop })),
);

type Phase = "idle" | "listening" | "thinking" | "speaking" | "error" | "denied";
type Turn = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Can you answer my business calls?",
  "Can you automate WhatsApp?",
  "Can you manage appointments?",
  "Can you connect to my existing systems?",
  "How much does ClickAI cost?",
];

const ORB_STATE = {
  idle: "idle",
  listening: "listen",
  thinking: "think",
  speaking: "speak",
} as const;

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Ready. Ask a question or tap the microphone.",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong. Try again.",
  denied: "Microphone access was blocked. You can type instead.",
};

// Minimal typing for the non-standard, vendor-prefixed API.
type Recognition = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

function getRecognition(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function HeroOrb() {
  const sendChat = useServerFn(publicChat);
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  // Capabilities are resolved after mount so server and client markup match.
  const [caps, setCaps] = useState({ gpu: false, speech: false, ready: false });

  const turnsRef = useRef<Turn[]>([]);
  const requestId = useRef(0);
  const recRef = useRef<Recognition | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setCaps({ gpu: "gpu" in navigator && !reduced, speech: !!getRecognition(), ready: true });
  }, []);

  const stop = useCallback(() => {
    requestId.current++; // drop any in-flight reply
    recRef.current?.abort();
    recRef.current = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setPhase("idle");
  }, []);

  // Release the microphone, speech output and pending replies on unmount.
  useEffect(() => stop, [stop]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, phase]);

  const speak = useCallback((text: string, id: number) => {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
      setPhase("idle");
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.onend = u.onerror = () => {
      if (requestId.current === id) setPhase("idle");
    };
    setPhase("speaking");
    synth.speak(u);
  }, []);

  const ask = useCallback(
    async (text: string, spoken: boolean) => {
      const message = text.trim().slice(0, 800);
      if (!message) return;
      recRef.current?.abort();
      window.speechSynthesis?.cancel();
      const id = ++requestId.current;
      const history = turnsRef.current;
      const next = [...history, { role: "user" as const, content: message }];
      turnsRef.current = next;
      setTurns(next);
      setInput("");
      setPhase("thinking");
      try {
        const res = await sendChat({ data: { message, history } });
        if (requestId.current !== id) return;
        const done = [...next, { role: "assistant" as const, content: res.reply }];
        turnsRef.current = done;
        setTurns(done);
        if (spoken) speak(res.reply, id);
        else setPhase("idle");
      } catch {
        if (requestId.current === id) setPhase("error");
      }
    },
    [sendChat, speak],
  );

  const listen = useCallback(() => {
    const Ctor = getRecognition();
    if (!Ctor) return;
    window.speechSynthesis?.cancel();
    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.interimResults = false;
    let heard = false;
    rec.onresult = (e) => {
      heard = true;
      const text = e.results[0]?.[0]?.transcript ?? "";
      void ask(text, true);
    };
    rec.onerror = (e) => {
      heard = true; // onend still fires; don't reset the phase we set here
      setPhase(e.error === "not-allowed" || e.error === "service-not-allowed" ? "denied" : "error");
    };
    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null;
      if (!heard) setPhase((p) => (p === "listening" ? "idle" : p));
    };
    recRef.current = rec;
    setPhase("listening");
    try {
      rec.start();
    } catch {
      setPhase("error");
    }
  }, [ask]);

  const reset = () => {
    stop();
    turnsRef.current = [];
    setTurns([]);
  };

  const busy = phase === "thinking";
  const active = phase === "listening" || phase === "speaking" || busy;
  const palette = BLOOP_PALETTES.BLUE;

  return (
    <section
      aria-label="Talk to the ClickAI assistant"
      className="relative mx-auto w-full max-w-[34rem]"
    >
      {/* Crop marks: a technical framing detail, decorative only. */}
      {[
        "left-0 top-0 border-l border-t",
        "right-0 top-0 border-r border-t",
        "bottom-0 left-0 border-b border-l",
        "bottom-0 right-0 border-b border-r",
      ].map((c) => (
        <span
          key={c}
          aria-hidden="true"
          className={`pointer-events-none absolute size-4 border-sky-300/50 ${c}`}
        />
      ))}

      <div className="px-5 pb-5 pt-4 sm:px-7">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3 font-mono text-xs uppercase tracking-[0.12em] text-slate-400">
          <span>ClickAI website assistant</span>
          <span className="flex items-center gap-2 text-slate-300">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                active ? "bg-sky-300" : "bg-slate-500",
                phase === "error" || phase === "denied" ? "bg-amber-400" : "",
              )}
            />
            {phase === "denied" ? "mic blocked" : phase}
          </span>
        </div>

        <div
          className="relative mx-auto mt-5 grid aspect-square w-full max-w-[19rem] place-items-center"
          aria-hidden="true"
        >
          <svg viewBox="0 0 320 320" className="absolute inset-0 size-full" fill="none">
            <circle cx="160" cy="160" r="150" stroke="rgba(255,255,255,0.12)" />
            <circle
              cx="160"
              cy="160"
              r="120"
              stroke={active ? "rgba(125,211,252,0.55)" : "rgba(125,211,252,0.22)"}
              strokeDasharray="2 7"
              className="transition-[stroke] duration-300 motion-reduce:transition-none"
            />
            <circle cx="160" cy="160" r="92" stroke="rgba(255,255,255,0.08)" />
            {TICKS.map(([x1, y1, x2, y2], i) => (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.28)" />
            ))}
          </svg>
          {caps.ready && caps.gpu ? (
            <Suspense fallback={<StaticOrb phase={phase} />}>
              <OrbBloop
                size={256}
                demoMode
                state={ORB_STATE[phase === "error" || phase === "denied" ? "idle" : phase]}
                bloopColorMain={palette.main}
                bloopColorLow={palette.low}
                bloopColorMid={palette.mid}
                bloopColorHigh={palette.high}
              />
            </Suspense>
          ) : (
            <StaticOrb phase={phase} />
          )}
        </div>

        <p role="status" aria-live="polite" className="mt-3 text-center text-sm text-slate-300">
          {PHASE_LABEL[phase]}
        </p>

        <div
          ref={logRef}
          role="log"
          aria-label="Conversation transcript"
          className="mt-4 max-h-36 min-h-12 space-y-2 overflow-y-auto border-l-2 border-white/15 pl-4 text-sm"
        >
          {turns.length === 0 ? (
            <p className="text-slate-400">Your conversation will appear here.</p>
          ) : (
            turns.map((t, i) => (
              <p key={i} className={t.role === "user" ? "text-white" : "text-sky-300"}>
                <span className="font-medium">{t.role === "user" ? "You: " : "ClickAI: "}</span>
                {t.content}
              </p>
            ))
          )}
        </div>

        <ul
          className="mt-4 grid border-t border-white/10 sm:grid-cols-2 sm:gap-x-6"
          aria-label="Suggested questions"
        >
          {SUGGESTIONS.map((q) => (
            <li key={q} className="border-b border-white/10">
              <button
                type="button"
                disabled={busy}
                onClick={() => void ask(q, false)}
                className="group flex min-h-11 w-full items-center justify-between gap-2 py-2 text-left text-sm text-slate-300 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-50"
              >
                {q}
                <span
                  aria-hidden="true"
                  className="text-slate-500 transition-transform group-hover:translate-x-0.5 group-hover:text-sky-300 motion-reduce:transition-none"
                >
                  →
                </span>
              </button>
            </li>
          ))}
        </ul>

        <form
          className="mt-4 flex items-center gap-2 border-b border-white/25 focus-within:border-sky-300"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input, false);
          }}
        >
          <label htmlFor="hero-orb-input" className="sr-only">
            Type your question
          </label>
          <input
            id="hero-orb-input"
            value={input}
            maxLength={800}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a question…"
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-slate-500"
          />
          {caps.speech ? (
            <button
              type="button"
              onClick={phase === "listening" ? stop : listen}
              aria-pressed={phase === "listening"}
              aria-label={phase === "listening" ? "Stop listening" : "Speak your question"}
              disabled={busy}
              className="grid size-11 place-items-center rounded-full text-slate-200 transition-[transform,background-color] hover:bg-white/10 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-50"
            >
              <Mic className="size-4" />
            </button>
          ) : null}
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send question"
            className="grid size-11 place-items-center rounded-full bg-violet-600 text-white transition-[transform,background-color] hover:bg-violet-500 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:opacity-40"
          >
            <Send className="size-4" />
          </button>
        </form>

        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-400">
          <span>
            AI answers, not a phone call.{" "}
            {caps.ready && !caps.speech
              ? "Voice input isn't supported in this browser; type instead."
              : "Voice uses your browser's speech service."}
          </span>
          <span className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={stop}
              disabled={!active}
              className="inline-flex min-h-8 items-center gap-1 rounded px-2 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-40"
            >
              <Square className="size-3" /> Stop
            </button>
            <button
              type="button"
              onClick={reset}
              className="inline-flex min-h-8 items-center gap-1 rounded px-2 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
            >
              <RotateCcw className="size-3" /> Restart
            </button>
          </span>
        </div>
      </div>
    </section>
  );
}

/** Tick marks around the outer ring, precomputed to fixed precision so server and client markup match. */
const TICKS: [string, string, string, string][] = Array.from({ length: 72 }, (_, i) => {
  const a = (i / 72) * Math.PI * 2;
  const long = i % 6 === 0;
  const r1 = long ? 150 : 150;
  const r2 = long ? 158 : 154;
  const f = (n: number) => (160 + n).toFixed(2);
  return [f(Math.cos(a) * r1), f(Math.sin(a) * r1), f(Math.cos(a) * r2), f(Math.sin(a) * r2)];
});

/** No-WebGPU / reduced-motion / still-loading orb: same state, no canvas. */
function StaticOrb({ phase }: { phase: Phase }) {
  return (
    <span
      className={cn(
        "block size-44 rounded-full bg-[radial-gradient(circle_at_35%_30%,#dcf7ff,#0181fe_70%,#1d4ed8)] transition-transform duration-500 motion-reduce:transition-none",
        phase === "listening" && "scale-105",
        phase === "thinking" && "scale-95",
        phase === "speaking" && "scale-110",
        (phase === "error" || phase === "denied") && "grayscale",
      )}
    />
  );
}
