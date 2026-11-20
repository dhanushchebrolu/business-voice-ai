import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Campaign context: draft from the customer's description, review and save, and
 * preview who would be called. Drafting and the preview read only; saving needs
 * a workspace owner or admin (the reviewed context is what every call says).
 */

async function authorizedOrg(
  context: { supabase: unknown; userId: string },
  campaignId: string,
  dial: boolean,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { campaignOrganizationForCaller } = await import("@/lib/outbound-authorization.server");
  const orgId = await campaignOrganizationForCaller(
    { supabase: context.supabase as typeof supabaseAdmin, supabaseAdmin },
    context.userId,
    campaignId,
    { dial },
  );
  return { orgId, supabaseAdmin };
}

export const prepareCampaignContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: string; description: string }) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    if (typeof input.description !== "string") throw new Error("description is required");
    if (input.description.length > 4000)
      throw new Error("Keep the description under 4000 characters.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { orgId, supabaseAdmin } = await authorizedOrg(context, data.campaignId, false);
    const { prepareCampaignContextFor } = await import("@/lib/campaign-context.server");
    const { claude } = await import("@/lib/claude.server");
    const { platformCapabilities } = await import("@/lib/campaign-context");
    const draft = claude.isConfigured()
      ? async (req: { system: string; user: string }) =>
          (
            await claude.runConversation(
              [
                { role: "system", content: req.system },
                { role: "user", content: req.user },
              ],
              { maxTokens: 1200 },
            )
          ).reply
      : null;
    const result = await prepareCampaignContextFor(
      supabaseAdmin,
      orgId,
      data.campaignId,
      data.description,
      draft,
    );
    return { ...result, capabilities: platformCapabilities() };
  });

export const saveCampaignContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: string; context: unknown; description?: string }) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { orgId, supabaseAdmin } = await authorizedOrg(context, data.campaignId, true);
    const { saveCampaignContextFor } = await import("@/lib/campaign-context.server");
    return saveCampaignContextFor(supabaseAdmin, orgId, data.campaignId, context.userId, {
      context: data.context,
      ...(typeof data.description === "string" ? { description: data.description } : {}),
    });
  });

export const getCampaignEligibility = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: string }) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { orgId, supabaseAdmin } = await authorizedOrg(context, data.campaignId, false);
    const { campaignEligibilityFor } = await import("@/lib/campaign-context.server");
    const { isDestinationCountryAllowed } = await import("@/lib/outbound-eligibility.server");
    return campaignEligibilityFor(
      supabaseAdmin,
      orgId,
      data.campaignId,
      isDestinationCountryAllowed,
    );
  });
