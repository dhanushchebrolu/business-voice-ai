/**
 * Runs the durable job queue on the Worker's cron trigger (wrangler.json
 * `triggers.crons`). Nitro's cloudflare-module preset turns the Worker's
 * scheduled() event into the `cloudflare:scheduled` hook
 * (node_modules/nitro/dist/presets/cloudflare/runtime/_module-handler.mjs),
 * awaited via waitUntil. A Nitro plugin is a plain function of the app.
 */
interface ScheduledEvent {
  controller: { scheduledTime: number; cron: string };
}

interface NitroAppLike {
  hooks: { hook: (name: string, fn: (event: ScheduledEvent) => Promise<void>) => unknown };
}

export default function scheduledJobsPlugin(nitroApp: NitroAppLike): void {
  nitroApp.hooks.hook("cloudflare:scheduled", async ({ controller }) => {
    const { handleScheduledEvent } = await import("../../src/lib/jobs/scheduler.server");
    await handleScheduledEvent(controller.scheduledTime);
  });
}
