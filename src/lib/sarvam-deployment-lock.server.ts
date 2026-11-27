import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * One lock per phone number, taken by every operation that changes that number's Sarvam
 * deployment: creation and adoption, the provisioning job's pause/sync/resume/activation,
 * sync, the live version move, webhook updates and their recovery, and the admin pause/resume.
 *
 * Kept in phone_numbers.metadata and written only if the row is unchanged since it was read,
 * so no migration is needed. It lapses after DEPLOYMENT_LOCK_MS in case a holder dies; a
 * holder calls confirm() before each provider change and stops if it has been taken over.
 */

type Admin = SupabaseClient<Database>;

export const DEPLOYMENT_BUSY_MESSAGE =
  "Another change to this number's deployment is in progress. Try again in a few minutes.";
/** Far longer than an operation's provider calls (15 s timeout each). */
const DEPLOYMENT_LOCK_MS = 5 * 60_000;
const KEY = "deployment_lock";

export class DeploymentBusyError extends Error {
  constructor() {
    super(DEPLOYMENT_BUSY_MESSAGE);
  }
}

export interface DeploymentLock {
  /** Extends the lock; throws DeploymentBusyError if this holder no longer has it. */
  confirm: () => Promise<void>;
  release: () => Promise<void>;
}

/** false: held by someone else, or (renewing) no longer ours, or the row changed meanwhile. */
async function write(
  admin: Admin,
  numberId: string,
  token: string,
  action: "acquire" | "renew" | "release",
): Promise<boolean> {
  const { data: row, error } = await admin
    .from("phone_numbers")
    .select("metadata, updated_at")
    .eq("id", numberId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return action !== "renew"; // no such number: the operation itself reports that
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const { [KEY]: current, ...rest } = metadata;
  const held = current as unknown as { token?: string; until?: string } | undefined;
  const ours = held?.token === token;
  if (action === "release" && !ours) return true; // lapsed and taken over: not ours to release
  if (action === "renew" && !ours) return false;
  if (action === "acquire" && held?.until && Date.parse(held.until) > Date.now()) return false;
  const next =
    action === "release"
      ? rest
      : {
          ...rest,
          [KEY]: { token, until: new Date(Date.now() + DEPLOYMENT_LOCK_MS).toISOString() },
        };
  const { data, error: writeError } = await admin
    .from("phone_numbers")
    .update({ metadata: next })
    .eq("id", numberId)
    .eq("updated_at", row.updated_at)
    .select("id");
  if (writeError) throw writeError;
  return Boolean(data?.length);
}

/** Locks every named number or none; throws DeploymentBusyError if any is held. */
export async function acquireDeploymentLock(
  admin: Admin,
  numberIds: string[],
): Promise<DeploymentLock> {
  const token = randomUUID();
  const held: string[] = [];
  const release = async () => {
    for (const id of held.splice(0)) {
      let released = false;
      for (let attempt = 0; attempt < 3 && !released; attempt++)
        released = await write(admin, id, token, "release").catch(() => false);
      if (!released) console.error("sarvam_deployment:lock_release_failed", id);
    }
  };
  try {
    // Sorted, so two callers naming the same numbers cannot each hold half.
    for (const id of [...new Set(numberIds)].sort()) {
      if (!(await write(admin, id, token, "acquire"))) throw new DeploymentBusyError();
      held.push(id);
    }
  } catch (err) {
    await release();
    throw err;
  }
  return {
    release,
    confirm: async () => {
      for (const id of held)
        if (!(await write(admin, id, token, "renew"))) throw new DeploymentBusyError();
    },
  };
}

export async function withDeploymentLock<T>(
  admin: Admin,
  numberIds: string[],
  work: (lock: DeploymentLock) => Promise<T>,
): Promise<T> {
  const lock = await acquireDeploymentLock(admin, numberIds);
  try {
    return await work(lock);
  } finally {
    await lock.release();
  }
}

/**
 * The lock of every number this customer still holds, for changes made per customer. Read
 * those numbers only inside `work`: taking the lock changes their rows.
 */
export async function withOrganizationDeploymentLock<T>(
  admin: Admin,
  organizationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const { data, error } = await admin
    .from("phone_numbers")
    .select("id, status")
    .eq("organization_id", organizationId)
    .eq("provider", "sarvam");
  if (error) throw error;
  return withDeploymentLock(
    admin,
    (data ?? []).filter((n) => n.status !== "released").map((n) => n.id),
    work,
  );
}
