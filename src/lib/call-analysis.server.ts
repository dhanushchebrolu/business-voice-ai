import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  buildAnalysisMessages,
  hasConversation,
  parseAnalysisReply,
  readTranscript,
  reconcileWithFacts,
  rulesAnalysis,
  wasAnswered,
  type CallAnalysis,
  type CallFactsInput,
} from "./call-analysis.ts";
import { callFacts } from "./sarvam-agent-api.server.ts";

type Db = SupabaseClient<Database>;

/** Tries the model gets per call before the call keeps its basic analysis. */
export const ANALYSIS_MAX_ATTEMPTS = 3;
/** A failed or waiting analysis is not retried sooner than this. */
export const ANALYSIS_RETRY_AFTER_MS = 10 * 60 * 1000;
/** Calls older than this are not picked up by the sweep (a report does not reach back forever). */
const SWEEP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const TERMINAL = ["completed", "failed", "no_answer", "busy", "cancelled"];

export interface AnalysisDeps {
  /** The model: messages in, its raw reply out. Null/absent when no AI is configured. */
  ai?:
    | ((messages: { role: "system" | "user"; content: string }[]) => Promise<{
        text: string;
        model: string;
      }>)
    | null;
  now?: () => Date;
}

/** The model the platform has (Anthropic), or no AI at all; never a guess at a key. */
export async function defaultAnalysisDeps(): Promise<AnalysisDeps> {
  const { claude } = await import("./claude.server.ts");
  if (!claude.isConfigured()) return { ai: null };
  return {
    ai: async (messages) => {
      const r = await claude.runConversation(messages, { maxTokens: 1500 });
      return { text: r.reply, model: process.env["CLAUDE_MODEL"] || "claude" };
    },
  };
}

export type AnalyzeResult =
  | { state: "analyzed"; status: string; source: "ai" | "rules" }
  | { state: "unchanged" }
  | { state: "not_final" }
  | { state: "not_found" };

interface CallRow {
  id: string;
  organization_id: string;
  direction: string;
  status: string;
  duration_seconds: number | null;
  transcript: Json | null;
  final_agent_variables: Json | null;
  campaign_id: string | null;
  campaign_contact_id: string | null;
  campaign_context_snapshot: Json | null;
  provider_metadata: Json | null;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What ClickAI's own tool log says happened on the call (booked, moved, cancelled), by interaction id. */
async function loadFacts(db: Db, call: CallRow): Promise<CallFactsInput> {
  const interactionId = text(obj(call.provider_metadata)["interaction_id"]);
  let events: { kind: string; status: string; detail: unknown }[] = [];
  if (interactionId) {
    const { data, error } = await db
      .from("sarvam_agent_events")
      .select("kind, status, detail, created_at")
      .eq("organization_id", call.organization_id)
      .eq("interaction_id", interactionId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    events = data ?? [];
  }
  const f = callFacts(events);
  return {
    status: call.status,
    durationSeconds: call.duration_seconds ?? 0,
    variables: obj(call.final_agent_variables),
    booking: { outcome: f.booking_outcome, id: f.booking_id },
    appointmentChanged: f.appointment_changed,
    changedBookingId: f.changed_booking_id,
  };
}

/**
 * Analyses one finished outbound call and stores the result. Safe to run any number of times:
 * a call is analysed once (unique per call), a finished analysis is never redone, a failed one
 * waits and is retried a bounded number of times, and an analysis made without the model is
 * redone with it when it becomes available. A call with nothing to read (unanswered, failed,
 * no transcript) is analysed from ClickAI's own records and is final.
 */
export async function analyzeCall(
  db: Db,
  callId: string,
  deps: AnalysisDeps = {},
): Promise<AnalyzeResult> {
  const now = deps.now?.() ?? new Date();
  const { data: call, error } = await db
    .from("call_logs")
    .select(
      "id, organization_id, direction, status, duration_seconds, transcript, final_agent_variables, campaign_id, campaign_contact_id, campaign_context_snapshot, provider_metadata",
    )
    .eq("id", callId)
    .maybeSingle();
  if (error) throw error;
  if (!call || call.direction !== "outbound") return { state: "not_found" };
  if (!TERMINAL.includes(call.status)) return { state: "not_final" };

  const { data: existing, error: existingError } = await db
    .from("call_analyses")
    .select("id, status, attempts, updated_at")
    .eq("call_id", callId)
    .maybeSingle();
  if (existingError) throw existingError;

  const turns = readTranscript(call.transcript);
  const readable = wasAnswered(call.status, call.duration_seconds ?? 0) && hasConversation(turns);
  if (existing) {
    if (existing.status === "done" || existing.status === "no_transcript")
      return { state: "unchanged" };
    const waited = now.getTime() - Date.parse(String(existing.updated_at));
    if (
      existing.status === "failed" &&
      (existing.attempts >= ANALYSIS_MAX_ATTEMPTS || waited < ANALYSIS_RETRY_AFTER_MS)
    )
      return { state: "unchanged" };
    // Waiting for, or failed at, the model: nothing to do until there is one.
    if ((existing.status === "pending_ai" || existing.status === "failed") && !deps.ai)
      return { state: "unchanged" };
  }

  const facts = await loadFacts(db, call);
  const snapshot = obj(call.campaign_context_snapshot);
  const attempts = existing?.attempts ?? 0;

  let analysis: CallAnalysis;
  let status: "done" | "pending_ai" | "no_transcript" | "failed";
  let source: "ai" | "rules";
  let model: string | null = null;
  let lastError: string | null = null;
  let nextAttempts = attempts;

  if (!readable) {
    analysis = rulesAnalysis(facts);
    status = "no_transcript";
    source = "rules";
  } else if (!deps.ai) {
    analysis = rulesAnalysis(facts);
    status = "pending_ai";
    source = "rules";
  } else {
    nextAttempts = attempts + 1;
    try {
      const reply = await deps.ai(
        buildAnalysisMessages({
          objective: text(snapshot["campaign_objective"]),
          instructions: text(snapshot["campaign_instructions"]),
          transcript: turns,
          facts,
        }),
      );
      const parsed = parseAnalysisReply(reply.text);
      if (!parsed.ok) throw new Error(parsed.error);
      analysis = reconcileWithFacts(parsed.value, facts);
      status = "done";
      source = "ai";
      model = reply.model;
    } catch (err) {
      // The model failed or answered badly: keep the basic analysis so the report still has
      // the call, and try again later (bounded).
      analysis = rulesAnalysis(facts);
      status = "failed";
      source = "rules";
      lastError = String((err as Error).message ?? err).slice(0, 500);
    }
  }

  const row = {
    organization_id: call.organization_id,
    call_id: call.id,
    campaign_id: call.campaign_id,
    campaign_contact_id: call.campaign_contact_id,
    status,
    source,
    model,
    analysis: analysis as unknown as Json,
    attempts: nextAttempts,
    last_error: lastError,
    analyzed_at: status === "failed" ? null : now.toISOString(),
  };
  if (existing) {
    const { error: updateError } = await db.from("call_analyses").update(row).eq("id", existing.id);
    if (updateError) throw updateError;
  } else {
    const { error: insertError } = await db.from("call_analyses").insert(row);
    // Another run analysed it first: that analysis stands.
    if (insertError && (insertError as { code?: string }).code === "23505")
      return { state: "unchanged" };
    if (insertError) throw insertError;
  }
  return { state: "analyzed", status, source };
}

export interface SweepSummary {
  considered: number;
  analyzed: number;
  failed: number;
  unchanged: number;
  errors: number;
}

/**
 * One pass of the background job: finished outbound calls that have no analysis yet, then
 * analyses that are failed or waiting for the model and due a retry. Bounded per run, oldest
 * waiting first, so a backlog clears over several runs without one long one.
 */
export async function sweepCallAnalyses(
  db: Db,
  deps: AnalysisDeps = {},
  limit = 5,
): Promise<SweepSummary> {
  const now = deps.now?.() ?? new Date();
  const summary: SweepSummary = { considered: 0, analyzed: 0, failed: 0, unchanged: 0, errors: 0 };
  const ids: string[] = [];

  const { data: recent, error } = await db
    .from("call_logs")
    .select("id, status, started_at, finalization_state")
    .eq("direction", "outbound")
    .in("status", TERMINAL)
    .order("started_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const cutoff = now.getTime() - SWEEP_WINDOW_MS;
  const finished = (recent ?? []).filter(
    (c) => c.finalization_state === "done" && Date.parse(String(c.started_at)) >= cutoff,
  );
  if (finished.length > 0) {
    const { data: have, error: haveError } = await db
      .from("call_analyses")
      .select("call_id")
      .in(
        "call_id",
        finished.map((c) => c.id),
      );
    if (haveError) throw haveError;
    const analysed = new Set((have ?? []).map((r) => r.call_id));
    for (const c of [...finished].reverse()) if (!analysed.has(c.id)) ids.push(c.id);
  }

  if (deps.ai) {
    const { data: retry, error: retryError } = await db
      .from("call_analyses")
      .select("call_id, status, attempts, updated_at")
      .in("status", ["failed", "pending_ai"])
      .order("updated_at", { ascending: true })
      .limit(50);
    if (retryError) throw retryError;
    for (const r of retry ?? []) {
      const due = now.getTime() - Date.parse(String(r.updated_at)) >= ANALYSIS_RETRY_AFTER_MS;
      if (due && r.attempts < ANALYSIS_MAX_ATTEMPTS && !ids.includes(r.call_id))
        ids.push(r.call_id);
    }
  }

  for (const id of ids.slice(0, limit)) {
    summary.considered++;
    try {
      const result = await analyzeCall(db, id, deps);
      if (result.state === "analyzed") {
        if (result.status === "failed") summary.failed++;
        else summary.analyzed++;
      } else summary.unchanged++;
    } catch (err) {
      summary.errors++;
      console.error("call_analysis:error", id, (err as Error).message);
    }
  }
  return summary;
}
