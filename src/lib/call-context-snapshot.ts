/**
 * The campaign context a single campaign call was admitted with
 * (call_logs.campaign_context_snapshot, written once by
 * admit_campaign_outbound_call and immutable afterwards). Shared by the
 * server loader and the read-only viewer; nothing here reads the database.
 */
import type { Json } from "@/integrations/supabase/types";

type JsonObject = { [key: string]: Json | undefined };

export interface ContextSnapshot {
  /** Context schema version the campaign held when the call was admitted. */
  version: number | null;
  /** When the campaign's context was reviewed (the version this call used). */
  reviewedAt: string | null;
  /** The structured context exactly as stored; values are shown, never interpreted. */
  context: JsonObject | null;
  /** The two agent variables the call actually sent to Sarvam. */
  sent: { objective: string; instructions: string };
}

export interface SnapshotCampaign {
  id: string;
  name: string | null;
  /** The campaign's current, editable context review time. */
  currentReviewedAt: string | null;
  currentVersion: number | null;
}

export type CallContextSnapshotView =
  /** Not a campaign call (inbound, or a single outbound call). */
  | { state: "not_campaign" }
  /** A campaign call with no snapshot: placed before snapshots existed, or never admitted. */
  | { state: "no_snapshot"; campaign: SnapshotCampaign | null }
  /** A snapshot is stored but is not in the expected shape. */
  | { state: "unreadable"; campaign: SnapshotCampaign | null }
  | {
      state: "snapshot";
      snapshot: ContextSnapshot;
      campaign: SnapshotCampaign | null;
      /** The campaign's context was re-reviewed after this call. */
      currentDiffers: boolean;
    };

const isRecord = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a stored snapshot defensively; null when it is not the shape admission writes. */
export function readContextSnapshot(raw: unknown): ContextSnapshot | null {
  if (!isRecord(raw) || !isRecord(raw["sent"])) return null;
  const sent = raw["sent"];
  const objective = sent["campaign_objective"];
  const instructions = sent["campaign_instructions"];
  if (typeof objective !== "string" || typeof instructions !== "string") return null;
  return {
    version: typeof raw["version"] === "number" ? raw["version"] : null,
    reviewedAt: typeof raw["reviewed_at"] === "string" ? raw["reviewed_at"] : null,
    context: isRecord(raw["context"]) ? raw["context"] : null,
    sent: { objective, instructions },
  };
}

/** Labels for the structured context, in the order the campaign editor shows them. */
export const SNAPSHOT_CONTEXT_FIELDS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["objective", "Objective"],
  ["audience", "Audience"],
  ["talkingPoints", "Talking points"],
  ["questions", "Questions to ask"],
  ["servicesInScope", "Services in scope"],
  ["desiredOutcome", "Desired outcome"],
  ["objectionHandling", "Objection handling"],
  ["callbackHandling", "Callback handling"],
  ["closing", "Closing"],
  ["tone", "Tone"],
  ["extraInstructions", "Extra instructions"],
  ["successCriteria", "Success criteria (reporting only, not sent)"],
];

/** A stored context value as display text, or a list of display items. */
export function snapshotFieldValue(value: unknown): string | string[] | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
    return items.length > 0 ? items : null;
  }
  return null;
}
