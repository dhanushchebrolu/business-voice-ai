import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  changeNote,
  DEFAULT_OUTBOUND_CONCURRENCY,
  parseOrgConcurrency,
  validateSelection,
  type OrgConcurrency,
} from "./outbound-concurrency.ts";

type Db = SupabaseClient<Database>;
type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>;

const rpcOf = (db: Db): Rpc => db.rpc.bind(db) as unknown as Rpc;

/** One customer's outbound allowance and what it is using right now. */
export async function readOrgConcurrency(db: Db, organizationId: string): Promise<OrgConcurrency> {
  const { data, error } = await rpcOf(db)("outbound_org_concurrency", { _org: organizationId });
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) throw new Error("Workspace not found.");
  return parseOrgConcurrency(row);
}

/**
 * The cap the dispatcher admits calls against. If it cannot be read, the default: a missing
 * answer never means more calls than a customer who has not chosen would get.
 */
export async function readOrgCap(db: Db, organizationId: string): Promise<number> {
  try {
    return (await readOrgConcurrency(db, organizationId)).cap;
  } catch {
    return DEFAULT_OUTBOUND_CONCURRENCY;
  }
}

export interface SavedConcurrency {
  state: OrgConcurrency;
  /** Set when calls already running are above the new cap: they finish, new ones wait. */
  note: string | null;
}

/**
 * Stores the customer's choice. The authority is the database (it clamps and enforces); this
 * validates against the live platform limit so the customer gets a clear answer, and never
 * touches a call in progress.
 */
export async function saveOrgConcurrency(
  db: Db,
  input: { organizationId: string; userId: string; value: unknown },
): Promise<SavedConcurrency> {
  const before = await readOrgConcurrency(db, input.organizationId);
  const check = validateSelection(input.value, before.slotLimit);
  if (!check.ok) throw new Error(check.message);
  const { error } = await db
    .from("organizations")
    .update({ outbound_concurrency: check.value })
    .eq("id", input.organizationId);
  if (error) throw error;
  const state = await readOrgConcurrency(db, input.organizationId);
  try {
    await db.from("audit_logs").insert({
      admin_user_id: input.userId,
      action: "OUTBOUND_CONCURRENCY_CHANGED",
      entity_type: "organization",
      entity_id: input.organizationId,
      organization_id: input.organizationId,
      old_value: { selected: before.selected, cap: before.cap } as unknown as Json,
      new_value: { selected: check.value, cap: state.cap } as unknown as Json,
      reason: "customer self-service action",
    });
  } catch (err) {
    console.error("outbound_concurrency:audit_write_failed", (err as Error).message);
  }
  return { state, note: changeNote(state.activeOutbound, state.cap) };
}

export interface OverviewRow {
  organizationId: string;
  name: string | null;
  selected: number | null;
  cap: number;
  activeOutbound: number;
  /** null: free to start more; otherwise why not. */
  limitedBy: "customer_setting" | "platform" | null;
}

export interface ConcurrencyOverview {
  slotLimit: number;
  inUse: number;
  free: number;
  customers: OverviewRow[];
}

/** For administrators: the platform's usage and each customer's choice, activity and limit. */
export async function readConcurrencyOverview(db: Db): Promise<ConcurrencyOverview> {
  const rpc = rpcOf(db);
  const [slots, rows] = await Promise.all([
    rpc("outbound_concurrency"),
    rpc("outbound_concurrency_overview"),
  ]);
  if (slots.error) throw new Error(slots.error.message);
  if (rows.error) throw new Error(rows.error.message);
  const g = slots.data?.[0] ?? {};
  const list = rows.data ?? [];
  const ids = list.map((r) => String(r["organization_id"]));
  const names = new Map<string, string | null>();
  if (ids.length > 0) {
    const { data, error } = await db.from("organizations").select("id, name").in("id", ids);
    if (error) throw error;
    for (const o of data ?? []) names.set(o.id, o.name ?? null);
  }
  return {
    slotLimit: Number(g["slot_limit"] ?? 0),
    inUse: Number(g["in_use"] ?? 0),
    free: Number(g["free"] ?? 0),
    customers: list.map((r) => ({
      organizationId: String(r["organization_id"]),
      name: names.get(String(r["organization_id"])) ?? null,
      selected: typeof r["selected"] === "number" ? (r["selected"] as number) : null,
      cap: Number(r["cap"] ?? 0),
      activeOutbound: Number(r["active_outbound"] ?? 0),
      limitedBy:
        r["limited_by"] === "customer_setting" || r["limited_by"] === "platform"
          ? (r["limited_by"] as "customer_setting" | "platform")
          : null,
    })),
  };
}
