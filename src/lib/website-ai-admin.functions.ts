/**
 * Admin-only management of the public "Website AI" knowledge base — the
 * ONLY content the public chatbot/voice assistant (src/lib/public-assistant.server.ts)
 * is allowed to draw from. This file never touches any customer/tenant
 * table; it is intentionally isolated from organizations, businesses, calls,
 * agent_configs, etc.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";

export const listKnowledgeBase = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "settings.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("public_knowledge_base")
      .select("*")
      .order("sort_order")
      .order("created_at");
    if (error) throw error;
    return data;
  });

interface UpsertKnowledgeInput {
  id?: string;
  title: string;
  content: string;
  category?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export const upsertKnowledgeEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: UpsertKnowledgeInput) => {
    if (!input?.title?.trim()) throw new Error("Title is required");
    if (!input?.content?.trim()) throw new Error("Content is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "settings.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const row = {
      title: data.title.trim(),
      content: data.content.trim(),
      category: data.category?.trim() || null,
      sort_order: data.sortOrder ?? 0,
      is_active: data.isActive ?? true,
      updated_at: new Date().toISOString(),
    };

    if (data.id) {
      const { error } = await supabaseAdmin
        .from("public_knowledge_base")
        .update(row)
        .eq("id", data.id);
      if (error) throw error;
      await writeAudit(admin, {
        action: "website_ai.knowledge_updated",
        entityType: "public_knowledge_base",
        entityId: data.id,
        newValue: row,
      });
    } else {
      const { data: inserted, error } = await supabaseAdmin
        .from("public_knowledge_base")
        .insert({ ...row, created_by: admin.userId })
        .select("id")
        .single();
      if (error) throw error;
      await writeAudit(admin, {
        action: "website_ai.knowledge_created",
        entityType: "public_knowledge_base",
        entityId: inserted.id,
        newValue: row,
      });
    }
    return { ok: true as const };
  });

export const setKnowledgeActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; isActive: boolean }) => {
    if (!input?.id) throw new Error("id is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "settings.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("public_knowledge_base")
      .update({ is_active: data.isActive, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw error;
    await writeAudit(admin, {
      action: data.isActive ? "website_ai.knowledge_activated" : "website_ai.knowledge_deactivated",
      entityType: "public_knowledge_base",
      entityId: data.id,
    });
    return { ok: true as const };
  });

export const deleteKnowledgeEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("id is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "settings.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("public_knowledge_base").delete().eq("id", data.id);
    if (error) throw error;
    await writeAudit(admin, {
      action: "website_ai.knowledge_deleted",
      entityType: "public_knowledge_base",
      entityId: data.id,
    });
    return { ok: true as const };
  });
