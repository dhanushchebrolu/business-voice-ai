/**
 * Call lifecycle policy for the voice agent: when a conversation should end,
 * how long to wait for the caller, and how hard to try before giving up.
 * Pure (no I/O) so every rule is unit-testable; voice-runtime.server.ts owns
 * the actual state and side effects (speaking, hanging up, terminating).
 *
 * The runtime keeps its existing RuntimeState machine. CallLifecyclePhase is
 * the coarse, log-facing view of it:
 *   ACTIVE            normal conversation, waiting on the caller
 *   WAITING_FOR_TOOL  the agent is thinking / running a tool
 *   WAITING_FOR_AUDIO the agent's reply is being played
 *   CLOSING           a final message is being delivered
 *   TERMINATING       provider-level hang-up has been initiated
 *   COMPLETED         the session ended normally
 *   FAILED            the session could not run or finish normally
 */

export type CallLifecyclePhase =
  | "ACTIVE"
  | "WAITING_FOR_TOOL"
  | "WAITING_FOR_AUDIO"
  | "CLOSING"
  | "TERMINATING"
  | "COMPLETED"
  | "FAILED";

export interface CallLifecyclePolicy {
  /** Caller silence before the one "are you still there?" prompt. */
  silencePromptMs: number;
  /** Further silence after that prompt before a goodbye and hang-up. */
  silenceHangupMs: number;
  /** The same agent reply this many times in a row ends the loop (offer an alternative). */
  repeatedReplyLimit: number;
  /** Consecutive failed turns (LLM/TTS/tool errors) before the call is ended safely. */
  consecutiveErrorLimit: number;
  /** Longest a final message may hold the call open waiting for its audio to finish. */
  closingAudioMaxWaitMs: number;
  /** Bound on one provider hang-up request. */
  providerHangupTimeoutMs: number;
  /** Extra hang-up attempts after a transient failure (network/5xx/timeout). */
  providerHangupRetries: number;
  /** Overall call length before the agent closes politely. 0 disables. */
  maxCallDurationMs: number;
  /** After maxCallDurationMs, how long to wait for an in-flight turn before closing anyway. */
  maxCallDurationGraceMs: number;
  /**
   * When the media connection closes without the runtime ending the call,
   * how long to wait for the provider's own call-ended webhook before
   * asking the provider to hang up (a confirmed caller hang-up needs no
   * request; an unconfirmed close may have left the line up).
   */
  mediaCloseHangupGraceMs: number;
  /** Whether a live transfer to a person is available on this deployment. */
  humanHandoffAvailable: boolean;
}

/**
 * Conservative defaults: the silence timings match the runtime's existing
 * behaviour (12 s prompt, then 10 s), nothing hangs up mid-operation, and a
 * long call is only closed after 30 minutes.
 */
export const DEFAULT_CALL_LIFECYCLE_POLICY: CallLifecyclePolicy = {
  silencePromptMs: 12_000,
  silenceHangupMs: 10_000,
  repeatedReplyLimit: 3,
  consecutiveErrorLimit: 2,
  closingAudioMaxWaitMs: 15_000,
  providerHangupTimeoutMs: 5_000,
  providerHangupRetries: 1,
  maxCallDurationMs: 30 * 60_000,
  maxCallDurationGraceMs: 60_000,
  mediaCloseHangupGraceMs: 3_000,
  humanHandoffAvailable: false,
};

/** Floors that stop a misconfiguration from producing aggressive hang-ups. */
const MINIMUMS: Partial<Record<keyof CallLifecyclePolicy, number>> = {
  silencePromptMs: 5_000,
  silenceHangupMs: 5_000,
  repeatedReplyLimit: 2,
  consecutiveErrorLimit: 1,
  closingAudioMaxWaitMs: 2_000,
  providerHangupTimeoutMs: 1_000,
  providerHangupRetries: 0,
  maxCallDurationGraceMs: 5_000,
  mediaCloseHangupGraceMs: 0,
};

/** Defaults overridden by `overrides`, with numeric values clamped to safe minimums. */
export function resolveCallLifecyclePolicy(
  overrides: Partial<CallLifecyclePolicy> = {},
): CallLifecyclePolicy {
  const policy: CallLifecyclePolicy = { ...DEFAULT_CALL_LIFECYCLE_POLICY };
  for (const [key, value] of Object.entries(overrides) as [keyof CallLifecyclePolicy, unknown][]) {
    if (key === "humanHandoffAvailable") {
      if (typeof value === "boolean") policy.humanHandoffAvailable = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (key === "maxCallDurationMs") {
      // 0 disables the limit; otherwise never below five minutes.
      policy.maxCallDurationMs = value <= 0 ? 0 : Math.max(value, 5 * 60_000);
      continue;
    }
    (policy[key] as number) = Math.max(Math.round(value), MINIMUMS[key] ?? 0);
  }
  return policy;
}

/** Test-only escape hatch: the same policy with no minimums applied (for fast deterministic tests). */
export function unclampedPolicyForTests(
  overrides: Partial<CallLifecyclePolicy>,
): CallLifecyclePolicy {
  return { ...DEFAULT_CALL_LIFECYCLE_POLICY, ...overrides };
}

export type CallerClosingIntent =
  /** "hang up", "end the call", "disconnect", "that's all" — the caller asked to end. */
  | "hangup_request"
  /** "bye", "goodbye". */
  | "goodbye"
  /** "no", "no thanks", "thank you" — only counts right after "anything else?". */
  | "nothing_else"
  /** "can I talk to a person / human / agent". */
  | "human_requested";

const HANGUP_REQUEST_PATTERN =
  /\b(?:hang\s?up|disconnect|end\s+(?:the|this)\s+call|cut\s+(?:the|this)\s+call|stop\s+(?:the|this)\s+call|nothing\s+else)\b|\bi'?m\s+done\b(?:[\s,]+(?:now|here|for\s+now|thanks?|thank\s+you))*\W*$|\bthat'?s\s+(?:all|it|everything)\b(?:[\s,]+(?:for\s+now|i\s+need(?:ed)?|thanks?|thank\s+you(?:\s+(?:so|very)\s+much)?))*\W*$/i;
// "Don't hang up", "please don't end the call".
const NEGATED_HANGUP_PATTERN =
  /\b(?:don'?t|do\s+not|never|not|no\s+need\s+to)\s+(?:hang|disconnect|end|cut|stop)\b/i;
const GOODBYE_PATTERN = /\b(?:good\s?bye|bye(?:\s+bye)?|see\s+you|take\s+care)\b/i;
const NOTHING_ELSE_PATTERN =
  /^\W*(?:no|nope|nah|no[\s,]+thanks?|no[\s,]+thank\s+you|thanks?|thank\s+you(?:\s+(?:so|very)\s+much)?|ok(?:ay)?[\s,]+thanks?|all\s+good|not\s+right\s+now|i'?m\s+(?:good|fine|all\s+set|ok(?:ay)?)(?:[\s,]+(?:thanks?|thank\s+you))?)\W*$/i;
const HUMAN_REQUEST_PATTERN =
  /\b(?:speak|talk|connect|transfer)\b[^.?!]*\b(?:human|person|someone|somebody|representative|receptionist|staff|agent|operator|manager|doctor)\b|\b(?:real|actual|live)\s+(?:person|human)\b/i;
/**
 * The same request in Telugu, Hindi and romanized speech — a person to talk
 * to, and a verb of speaking: "మనిషితో మాట్లాడాలి", "डॉक्टर से बात कराइए",
 * "kisi se baat karni hai". Both are required, so "किसी बात की चिंता नहीं"
 * ("no worries about anything") is never one.
 */
const NATIVE_HUMAN_REQUEST_PATTERN =
  /(?:మనిషి|వ్యక్తి|ఎవరితో|డాక్టర్|స్టాఫ్|రిసెప్షనిస్ట్|మేనేజర్|సిబ్బంది)[^.?!।]*మాట్లాడ|(?:इंसान|व्यक्ति|आदमी|डॉक्टर|डाक्टर|स्टाफ|मैनेजर|रिसेप्शनिस्ट|किसी\s+से)[^.?!।]*(?:बात|बोल)|\b(?:insaan|insan|vyakti|aadmi|doctor|staff|manager|manishi|evaritho|kisi\s+se)\b[^.?!]*\b(?:baat|bolna|matlad\w*)\b/iu;
// "Thanks — can I also ask about prices?" is a new request, not a goodbye.
const CONTINUATION_PATTERN =
  /\?|\b(?:also|another|one\s+more|but|what|how|when|where|why|which|can\s+(?:i|you)|could\s+(?:i|you)|i\s+(?:want|need|would\s+like)|book|reschedule|cancel|change|price|cost|open|available)\b/i;

/**
 * What the caller's turn means for the call's lifecycle, or null for an
 * ordinary conversational turn. Never a closing intent when the same turn
 * also carries a new request (a question, a date/time, "but…").
 *
 * - hangup_request / goodbye: at any point in the call.
 * - nothing_else: only when the agent's previous turn asked whether there
 *   was anything else (`awaitingAnythingElse`) — otherwise a bare "no" or
 *   "thank you" is an answer to something else.
 * - human_requested: any point.
 */
export function classifyCallerClosingIntent(
  text: string,
  ctx: { awaitingAnythingElse: boolean; hasNewRequest: boolean },
): CallerClosingIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (HUMAN_REQUEST_PATTERN.test(trimmed) || NATIVE_HUMAN_REQUEST_PATTERN.test(trimmed)) {
    return "human_requested";
  }
  if (ctx.hasNewRequest) return null;
  const continues = CONTINUATION_PATTERN.test(trimmed);
  if (HANGUP_REQUEST_PATTERN.test(trimmed) && !continues && !NEGATED_HANGUP_PATTERN.test(trimmed)) {
    return "hangup_request";
  }
  if (GOODBYE_PATTERN.test(trimmed) && !continues) return "goodbye";
  if (ctx.awaitingAnythingElse && NOTHING_ELSE_PATTERN.test(trimmed)) return "nothing_else";
  return null;
}

/** The agent's reply asked whether the caller needs anything else. */
export function agentAskedAnythingElse(reply: string): boolean {
  return /\b(?:anything\s+else|any\s+other\s+(?:questions?|thing)|anything\s+more|something\s+else\s+i\s+can|else\s+can\s+i\s+help)\b/i.test(
    reply,
  );
}

/** The agent's reply already said goodbye. */
export function agentSaidGoodbye(reply: string): boolean {
  return /\b(?:good\s?bye|bye|have\s+a\s+(?:great|good|nice|lovely|wonderful)\s+(?:day|evening|night|one))\b/i.test(
    reply,
  );
}

/**
 * Normalised form of a reply for "said the same thing again" detection.
 * Letters, digits and combining marks of every script are kept (Indic vowel
 * signs are marks): with only a-z0-9 kept, any non-English reply normalised
 * to "", so a Hindi or Telugu agent could repeat itself indefinitely.
 */
export function normalizeReplyForRepeat(reply: string): string {
  return reply
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

/** Log-facing lifecycle phase for a runtime state (see this module's doc). */
export function lifecyclePhaseFor(
  state: string,
  ctx: { closing: boolean; terminating: boolean; audioPlaying: boolean },
): CallLifecyclePhase {
  if (state === "failed") return "FAILED";
  if (state === "ended") return "COMPLETED";
  if (ctx.terminating || state === "ending") return "TERMINATING";
  if (ctx.closing) return "CLOSING";
  if (state === "thinking") return "WAITING_FOR_TOOL";
  if (state === "speaking" || state === "greeting" || ctx.audioPlaying) return "WAITING_FOR_AUDIO";
  return "ACTIVE";
}

/** A failed provider hang-up worth one more attempt (network, timeout, 5xx); never a 4xx. */
export function isTransientHangupError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status >= 500 || status === 408 || status === 429;
  return true; // network error or our own deadline
}

/** Spoken closings — deterministic so a failing LLM can never block a call from ending. */
export const CLOSING_MESSAGES = {
  farewell: (businessName: string) => `Thank you for calling ${businessName}. Goodbye!`,
  hangupRequested: (businessName: string) =>
    `Of course. Thank you for calling ${businessName}. Goodbye!`,
  silence: "I haven't heard anything, so I'll end the call here. Feel free to call back anytime.",
  repeatedErrors:
    "I'm sorry, we're having technical difficulties right now. Please call back in a little while. Goodbye.",
  maxDuration: (businessName: string) =>
    `We've reached the time limit for this call. Thank you for calling ${businessName}. Goodbye!`,
  repeatedQuestion:
    "I'm sorry, I don't seem to be able to sort this out on this call. You're welcome to call back, or contact the team directly. Is there anything else I can help you with?",
  humanUnavailable:
    "I'm sorry, I can't transfer you to a person on this call. You're welcome to call back during opening hours to speak with the team. Is there anything else I can help you with?",
} as const;

/**
 * The closing line for a caller-initiated close: a brief acknowledgement
 * when they explicitly asked to hang up / end the call, otherwise the
 * normal farewell.
 */
export function closingMessageFor(text: string, businessName: string): string {
  return /\b(?:hang\s?up|disconnect|end\s+(?:the|this)\s+call|cut\s+(?:the|this)\s+call|stop\s+(?:the|this)\s+call)\b/i.test(
    text,
  )
    ? CLOSING_MESSAGES.hangupRequested(businessName)
    : CLOSING_MESSAGES.farewell(businessName);
}
