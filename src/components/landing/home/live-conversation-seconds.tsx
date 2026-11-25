import { useEffect, useRef, useState } from "react";
import {
  formatSeconds,
  parseConversationStats,
  projectSeconds,
  type ConversationStats,
} from "@/lib/conversation-counter";

const ENDPOINT = "/api/public/stats/conversation-time";
const REFRESH_MS = 30_000;

/**
 * Seconds ClickAI has handled in conversations, all customers combined: the
 * server's total plus, while calls are connected, one second per second per
 * call. Re-read every 30 s (and when the tab returns) to reconcile with the
 * database. Until a first read succeeds it shows a dash, never a made-up
 * number; if a refresh fails it keeps counting from the last good read.
 */
export function LiveConversationSeconds() {
  const [display, setDisplay] = useState<number | null>(null);
  const [active, setActive] = useState(false);
  const read = useRef<{ stats: ConversationStats; at: number } | null>(null);
  const shown = useRef(0);

  useEffect(() => {
    let stopped = false;
    const render = () => {
      const r = read.current;
      if (!r) return;
      // Never steps backwards: a call that just ended swaps its live estimate for its final duration.
      shown.current = Math.max(
        shown.current,
        projectSeconds(r.stats, (performance.now() - r.at) / 1000),
      );
      setDisplay(shown.current);
      setActive(r.stats.activeCalls > 0);
    };
    const refresh = async () => {
      try {
        const res = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
        const stats = res.ok ? parseConversationStats(await res.json()) : null;
        if (stats && !stopped) {
          read.current = { stats, at: performance.now() };
          render();
        }
      } catch {
        /* keep the last good read */
      }
    };
    void refresh();
    const poll = setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    const tick = setInterval(() => {
      if (!document.hidden && read.current?.stats.activeCalls) render();
    }, 1000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <>
      <span className="inline-block min-w-[9ch] tabular-nums" aria-live="off">
        {display === null ? "—" : formatSeconds(display)}
      </span>
      <span className="sr-only">seconds of conversations handled</span>
      <span
        className="ml-3 inline-flex translate-y-[-0.6em] items-center gap-1.5 align-middle font-vmono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--vx-accent)]"
        aria-hidden="true"
      >
        <span
          className={`size-1.5 rounded-full bg-[var(--vx-accent)] ${active ? "motion-safe:animate-pulse" : "opacity-40"}`}
        />
        Live
      </span>
    </>
  );
}
