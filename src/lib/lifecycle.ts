import type { Database } from "@/integrations/supabase/types";

export type LifecycleStatus = Database["public"]["Enums"]["lifecycle_status"];

/** Client-safe lifecycle metadata shared by the admin control centre and the customer app. */
export const LIFECYCLE: Record<
  LifecycleStatus,
  { label: string; tone: "live" | "ready" | "idle" | "error" | "info" | "accent"; description: string }
> = {
  not_provisioned: {
    label: "Not provisioned",
    tone: "idle",
    description: "Account exists but no workspace has been prepared yet.",
  },
  setup_payment_pending: {
    label: "Setup payment pending",
    tone: "ready",
    description: "Waiting for the one-time setup payment to be confirmed.",
  },
  setup_paid: {
    label: "Setup paid",
    tone: "info",
    description: "Setup payment verified. Ready to provision.",
  },
  provisioning: {
    label: "Provisioning",
    tone: "info",
    description: "Workspace and services are being configured.",
  },
  ready: {
    label: "Ready",
    tone: "accent",
    description: "Workspace prepared — invitation can be sent.",
  },
  active: { label: "Active", tone: "live", description: "Customer has full dashboard access." },
  suspended: { label: "Suspended", tone: "error", description: "Access suspended by the platform." },
  cancelled: { label: "Cancelled", tone: "error", description: "Customer has cancelled." },
  archived: { label: "Archived", tone: "idle", description: "Archived. Financial history is preserved." },
};

export const LIFECYCLE_ORDER: LifecycleStatus[] = [
  "not_provisioned",
  "setup_payment_pending",
  "setup_paid",
  "provisioning",
  "ready",
  "active",
  "suspended",
  "cancelled",
  "archived",
];

/** Lifecycle states where the customer must NOT see the operational dashboard. */
export const PENDING_LIFECYCLE: LifecycleStatus[] = [
  "not_provisioned",
  "setup_payment_pending",
  "setup_paid",
  "provisioning",
];

export const CRM_STAGES = ["lead", "prospect", "customer", "churned"] as const;
export type CrmStage = (typeof CRM_STAGES)[number];
