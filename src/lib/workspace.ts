import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Organization = Database["public"]["Tables"]["organizations"]["Row"];
export type Business = Database["public"]["Tables"]["businesses"]["Row"];
export type AgentConfig = Database["public"]["Tables"]["agent_configs"]["Row"];
export type Subscription = Database["public"]["Tables"]["subscriptions"]["Row"];
export type ServiceRow = Database["public"]["Tables"]["services"]["Row"];
export type FaqRow = Database["public"]["Tables"]["faqs"]["Row"];
export type RuleRow = Database["public"]["Tables"]["business_rules"]["Row"];
export type HoursRow = Database["public"]["Tables"]["business_hours"]["Row"];
export type CallRow = Database["public"]["Tables"]["call_logs"]["Row"];
export type LeadRow = Database["public"]["Tables"]["leads"]["Row"];
export type PhoneNumberRow = Database["public"]["Tables"]["phone_numbers"]["Row"];
export type KnowledgeRow = Database["public"]["Tables"]["knowledge_documents"]["Row"];
export type AgentVersionRow = Database["public"]["Tables"]["agent_versions"]["Row"];

export interface WorkspaceData {
  organization: Organization | null;
  business: Business | null;
  agent: AgentConfig | null;
  subscription: Subscription | null;
  role: string | null;
}

export const workspaceQuery = (userId: string | undefined) =>
  queryOptions({
    queryKey: ["workspace", userId],
    enabled: Boolean(userId),
    queryFn: async (): Promise<WorkspaceData> => {
      const { data: membership, error } = await supabase
        .from("organization_members")
        .select("role, organization_id, organizations(*)")
        .order("created_at")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const organization = (membership?.organizations as Organization | null) ?? null;
      if (!organization) return { organization: null, business: null, agent: null, subscription: null, role: null };

      const [businessRes, subRes] = await Promise.all([
        supabase.from("businesses").select("*").eq("organization_id", organization.id).order("created_at").limit(1).maybeSingle(),
        supabase.from("subscriptions").select("*").eq("organization_id", organization.id).maybeSingle(),
      ]);

      const business = businessRes.data ?? null;
      let agent: AgentConfig | null = null;
      if (business) {
        const { data } = await supabase.from("agent_configs").select("*").eq("business_id", business.id).maybeSingle();
        agent = data ?? null;
      }

      return {
        organization,
        business,
        agent,
        subscription: subRes.data ?? null,
        role: membership?.role ?? null,
      };
    },
  });

export const servicesQuery = (businessId: string | undefined) =>
  queryOptions({
    queryKey: ["services", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("*")
        .eq("business_id", businessId!)
        .order("sort_order")
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });

export const faqsQuery = (businessId: string | undefined) =>
  queryOptions({
    queryKey: ["faqs", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const { data, error } = await supabase.from("faqs").select("*").eq("business_id", businessId!).order("sort_order");
      if (error) throw error;
      return data;
    },
  });

export const rulesQuery = (businessId: string | undefined) =>
  queryOptions({
    queryKey: ["rules", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const { data, error } = await supabase.from("business_rules").select("*").eq("business_id", businessId!).order("priority");
      if (error) throw error;
      return data;
    },
  });

export const hoursQuery = (businessId: string | undefined) =>
  queryOptions({
    queryKey: ["hours", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const { data, error } = await supabase.from("business_hours").select("*").eq("business_id", businessId!).order("day_of_week");
      if (error) throw error;
      return data;
    },
  });

export const knowledgeQuery = (businessId: string | undefined) =>
  queryOptions({
    queryKey: ["knowledge", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("knowledge_documents")
        .select("*")
        .eq("business_id", businessId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

export const versionsQuery = (businessId: string | undefined) =>
  queryOptions({
    queryKey: ["agent-versions", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("agent_versions")
        .select("id, version, status, change_note, created_at")
        .eq("business_id", businessId!)
        .order("version", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

export const callsQuery = (organizationId: string | undefined) =>
  queryOptions({
    queryKey: ["calls", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("call_logs")
        .select("*")
        .eq("organization_id", organizationId!)
        .order("started_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data;
    },
  });

export const leadsQuery = (organizationId: string | undefined) =>
  queryOptions({
    queryKey: ["leads", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .eq("organization_id", organizationId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

export const numbersQuery = (organizationId: string | undefined) =>
  queryOptions({
    queryKey: ["numbers", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("phone_numbers")
        .select("*")
        .eq("organization_id", organizationId!)
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });

export const usageQuery = (organizationId: string | undefined) =>
  queryOptions({
    queryKey: ["usage", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("usage_records")
        .select("*")
        .eq("organization_id", organizationId!)
        .order("occurred_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data;
    },
  });

export function agentStatusLabel(agent: AgentConfig | null, hasNumber: boolean): {
  label: string;
  tone: "live" | "ready" | "idle" | "error";
} {
  if (!agent || agent.active_version === 0) return { label: "Not configured", tone: "idle" };
  if (agent.status === "error") return { label: "Error", tone: "error" };
  if (agent.status === "paused") return { label: "Paused", tone: "idle" };
  if (hasNumber && agent.status === "live") return { label: "Live", tone: "live" };
  return { label: "Ready — no number", tone: "ready" };
}

export type PaymentRow = Database["public"]["Tables"]["payments"]["Row"];
export type PaymentOrderRow = Database["public"]["Tables"]["payment_orders"]["Row"];
export type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];
export type AccountStatus = Database["public"]["Enums"]["account_status"];

export const paymentsQuery = (orgId: string | undefined) =>
  queryOptions({
    queryKey: ["payments", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("organization_id", orgId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

export const invoicesQuery = (orgId: string | undefined) =>
  queryOptions({
    queryKey: ["invoices", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .eq("organization_id", orgId!)
        .order("issued_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, { label: string; tone: "live" | "ready" | "idle" | "accent" | "error" }> = {
  payment_required: { label: "Payment required", tone: "error" },
  setup_in_progress: { label: "Setup in progress", tone: "ready" },
  active: { label: "Active", tone: "live" },
  suspended: { label: "Suspended", tone: "error" },
  cancelled: { label: "Cancelled", tone: "idle" },
};
