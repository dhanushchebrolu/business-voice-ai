import {
  evaluateCampaignLaunchReadiness,
  type LaunchCheck,
  type ReadinessDeps,
} from "./campaign-launch-readiness.server.ts";

export type LaunchResult =
  { ok: true; status: "running"; alreadyRunning: boolean } | { ok: false; blockers: LaunchCheck[] };

/**
 * The launch itself, for one campaign of `orgId` (the caller is already
 * authorized as an owner or admin). Runs every readiness check; refuses with
 * all failing checks, or moves the campaign to running with one conditional
 * update (a cancel or a concurrent launch that landed meanwhile wins). Every
 * attempt is audited; an audit failure never changes the result.
 */
export async function launchCampaignFor(
  deps: ReadinessDeps,
  orgId: string,
  userId: string,
  campaignId: string,
): Promise<LaunchResult> {
  const { db } = deps;
  const readiness = await evaluateCampaignLaunchReadiness(deps, orgId, campaignId);
  if (!readiness) throw new Error("Campaign not found.");
  // A repeated launch (double click, retry after a lost response) is not an error.
  if (readiness.status === "running") return { ok: true, status: "running", alreadyRunning: true };

  const audit = async (action: string, value: unknown) => {
    try {
      await db.from("audit_logs").insert({
        admin_user_id: userId,
        action,
        entity_type: "campaign",
        entity_id: campaignId,
        organization_id: orgId,
        new_value: value as never,
        reason: "customer self-service action",
      });
    } catch (err) {
      console.error("campaign_launch:audit_write_failed", (err as Error).message);
    }
  };

  const blockers = readiness.checks.filter((c) => !c.ok);
  if (blockers.length > 0) {
    await audit("CAMPAIGN_LAUNCH_BLOCKED", { blockers: blockers.map((b) => b.key) });
    return { ok: false, blockers };
  }

  const { data: launched, error } = await db
    .from("campaigns")
    .update({ status: "running", launched_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("organization_id", orgId)
    .in("status", ["draft", "scheduled", "paused"])
    .select("id");
  if (error) throw error;
  if (!launched?.length) {
    const { data: now } = await db
      .from("campaigns")
      .select("status")
      .eq("id", campaignId)
      .maybeSingle();
    if (now?.status === "running") return { ok: true, status: "running", alreadyRunning: true };
    throw new Error("The campaign changed status; reload and try again.");
  }
  await audit("CAMPAIGN_LAUNCHED", {
    from: readiness.status,
    callerNumberId: readiness.callerNumber?.id,
  });
  return { ok: true, status: "running", alreadyRunning: false };
}
