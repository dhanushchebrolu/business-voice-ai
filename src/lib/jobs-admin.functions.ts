import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";

/**
 * Platform-admin view of the durable job queue: health (per kind/status and
 * the oldest due job's age), the dead-letter list, and requeueing a dead job.
 * Reads and writes go through the queue's own SQL functions/table as the
 * service role; customers never reach these.
 */

export const getJobQueueOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: stats, error: statsError }, { data: dead, error: deadError }, { data: recent }] =
      await Promise.all([
        supabaseAdmin.rpc("job_queue_stats", {}),
        supabaseAdmin
          .from("jobs")
          .select(
            "id, kind, organization_id, attempts, max_attempts, last_error, dead_at, created_at",
          )
          .eq("status", "dead")
          .order("dead_at", { ascending: false })
          .limit(50),
        supabaseAdmin
          .from("jobs")
          .select("id, kind, status, attempts, run_at, completed_at, last_error")
          .order("updated_at", { ascending: false })
          .limit(25),
      ]);
    if (statsError) throw statsError;
    if (deadError) throw deadError;
    return {
      stats: (stats ?? []).map((s) => ({
        kind: s.kind,
        status: s.status,
        jobs: Number(s.jobs),
        oldestDueSeconds: s.oldest_due_seconds,
      })),
      dead: dead ?? [],
      recent: recent ?? [],
      schedulerEnabled: process.env["JOBS_SCHEDULER_ENABLED"] !== "false",
    };
  });

export const requeueDeadJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { jobId: string; reason: string }) => {
    if (!input?.jobId) throw new Error("jobId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "settings.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: job } = await supabaseAdmin
      .from("jobs")
      .select("id, kind, organization_id, last_error")
      .eq("id", data.jobId)
      .maybeSingle();
    if (!job) throw new Error("Job not found");
    const { data: requeued, error } = await supabaseAdmin.rpc("requeue_dead_job", { _id: job.id });
    if (error) throw error;
    if (!requeued) throw new Error("Only a dead-lettered job can be requeued.");
    await writeAudit(admin, {
      action: "JOB_REQUEUED",
      entityType: "job",
      entityId: job.id,
      organizationId: job.organization_id,
      oldValue: { status: "dead", last_error: job.last_error },
      newValue: { status: "queued", kind: job.kind },
      reason: data.reason,
    });
    return { ok: true as const };
  });
