import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Voice AI provisioning retries — schedule every minute (Bearer
 * LOVABLE_CRON_SECRET, like the other /api/public/cron routes). Picks up
 *   1. jobs whose automatic retry is due (pending + next_attempt_at <= now),
 *   2. jobs stuck "running" past the stale window (a crashed attempt).
 * runProvisioning re-checks everything (claim, backoff time, attempt bound),
 * so overlapping sweeps or a concurrent customer click never double-run a job.
 * Returns counts only.
 */
export const Route = createFileRoute("/api/public/cron/provisioning-retry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authError = await authenticateCronRequest(request);
        if (authError) return authError;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runProvisioning, STALE_RUNNING_MS } =
          await import("@/lib/provisioning-runs.server");
        const now = new Date();
        const [due, stuck] = await Promise.all([
          supabaseAdmin
            .from("provisioning_runs")
            .select("organization_id, trigger")
            .eq("status", "pending")
            .lte("next_attempt_at", now.toISOString())
            .order("next_attempt_at", { ascending: true })
            .limit(10),
          supabaseAdmin
            .from("provisioning_runs")
            .select("organization_id, trigger")
            .eq("status", "running")
            .lt("updated_at", new Date(now.getTime() - STALE_RUNNING_MS).toISOString())
            .limit(10),
        ]);
        if (due.error || stuck.error) {
          console.error(
            "provisioning_retry_cron:query_failed",
            (due.error ?? stuck.error)?.message,
          );
          return new Response(JSON.stringify({ error: "query_failed" }), { status: 500 });
        }
        let processed = 0;
        let errors = 0;
        for (const r of [...(due.data ?? []), ...(stuck.data ?? [])]) {
          try {
            const out = await runProvisioning(supabaseAdmin, {
              organizationId: r.organization_id,
              trigger: r.trigger as
                "setup_fee" | "phone_service_fee" | "admin_retry" | "customer_activate",
            });
            if (out.claimed) processed++;
          } catch (err) {
            errors++;
            console.error("provisioning_retry_cron:run_failed", (err as Error).message);
          }
        }
        return new Response(
          JSON.stringify({
            due: due.data?.length ?? 0,
            stuck: stuck.data?.length ?? 0,
            processed,
            errors,
          }),
          {
            status: errors > 0 ? 500 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  },
});
