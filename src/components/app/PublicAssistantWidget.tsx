import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { MessageCircle, Mic, Send, Square, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  publicChat,
  publicVoiceTurn,
  getWebsiteAiPublicSettings,
} from "@/lib/public-assistant.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Public floating chat + voice assistant. Talks ONLY to publicChat/
 * publicVoiceTurn (src/lib/public-assistant.functions.ts) — those functions
 * never see any customer/tenant data, so nothing this widget does can leak
 * across a customer boundary.
 */
export function PublicAssistantWidget() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"chat" | "voice">("chat");
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [welcome, setWelcome] = useState("Hi! Ask me anything about Vaani.");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);

  const fetchSettings = useServerFn(getWebsiteAiPublicSettings);
  const sendChat = useServerFn(publicChat);
  const sendVoice = useServerFn(publicVoiceTurn);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || settingsLoaded) return;
    fetchSettings()
      .then((s) => {
        setVoiceEnabled(s.voiceEnabled);
        setWelcome(s.welcomeMessage);
        setSettingsLoaded(true);
      })
      .catch(() => setSettingsLoaded(true));
  }, [open, settingsLoaded, fetchSettings]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const nextHistory = [...messages, { role: "user" as const, content: text.trim() }];
    setMessages(nextHistory);
    setInput("");
    setBusy(true);
    try {
      const result = await sendChat({ data: { message: text.trim(), history: messages } });
      setMessages([...nextHistory, { role: "assistant", content: result.reply }]);
    } catch {
      setMessages([
        ...nextHistory,
        { role: "assistant", content: "Sorry, something went wrong. Please try again." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    setVoiceStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void handleRecordingStopped(recorder.mimeType || "audio/webm");
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setVoiceStatus("Microphone access was denied or is unavailable.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function handleRecordingStopped(mimeType: string) {
    const blob = new Blob(chunksRef.current, { type: mimeType });
    if (blob.size === 0) return;
    setBusy(true);
    setVoiceStatus("Processing…");
    try {
      const base64 = await blobToBase64(blob);
      const result = await sendVoice({
        data: { audioBase64: base64, mimeType, history: messages },
      });
      if (!result.ok) {
        setVoiceStatus(result.reason);
        return;
      }
      const nextHistory: ChatTurn[] = [
        ...messages,
        { role: "user", content: result.transcript },
        { role: "assistant", content: result.reply },
      ];
      setMessages(nextHistory);
      setVoiceStatus(null);
      const audio = new Audio(`data:audio/wav;base64,${result.audioBase64}`);
      void audio.play().catch(() => {});
    } catch {
      setVoiceStatus("Could not process that recording. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close Vaani assistant" : "Open Vaani assistant"}
        className="fixed bottom-5 right-5 z-40 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
      >
        {open ? <X className="size-5" /> : <MessageCircle className="size-5" />}
      </button>

      {open ? (
        <div className="fixed bottom-24 right-5 z-40 flex h-[480px] w-[340px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-semibold">Talk to Vaani</p>
              <p className="text-xs text-muted-foreground">Public assistant · no account data</p>
            </div>
            {voiceEnabled ? (
              <div className="flex gap-1 rounded-md border border-border p-0.5">
                <button
                  onClick={() => setMode("chat")}
                  className={cn(
                    "rounded px-2 py-1 text-xs",
                    mode === "chat" ? "bg-accent" : "text-muted-foreground",
                  )}
                >
                  Chat
                </button>
                <button
                  onClick={() => setMode("voice")}
                  className={cn(
                    "rounded px-2 py-1 text-xs",
                    mode === "voice" ? "bg-accent" : "text-muted-foreground",
                  )}
                >
                  Voice
                </button>
              </div>
            ) : null}
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{welcome}</p>
            ) : null}
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  m.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {m.content}
              </div>
            ))}
            {busy ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Thinking…
              </div>
            ) : null}
          </div>

          {mode === "chat" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex items-center gap-2 border-t border-border p-3"
            >
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about Vaani…"
                disabled={busy}
                autoFocus
              />
              <Button size="icon" type="submit" disabled={busy || !input.trim()}>
                <Send className="size-4" />
              </Button>
            </form>
          ) : (
            <div className="flex flex-col items-center gap-2 border-t border-border p-3">
              {voiceStatus ? <p className="text-xs text-muted-foreground">{voiceStatus}</p> : null}
              <Button
                type="button"
                variant={recording ? "destructive" : "default"}
                className="w-full"
                disabled={busy && !recording}
                onClick={recording ? stopRecording : startRecording}
              >
                {recording ? <Square className="mr-2 size-4" /> : <Mic className="mr-2 size-4" />}
                {recording ? "Stop and send" : "Hold to speak"}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
