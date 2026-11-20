/**
 * The simulated backend for the customer status harness: what ClickAI's
 * database holds for one customer at each point of dual-agent provisioning.
 * Persisted in localStorage, so a page refresh shows the same stage (the real
 * app re-reads the database on refresh the same way).
 */
export const STAGES = [
  {
    id: "paid",
    label: "Setup fee paid, onboarding saved (pending)",
    lifecycle: "setup_paid",
    inbound: false,
    outbound: false,
    number: null,
  },
  {
    id: "number_assigned",
    label: "Number assigned, inbound agent not registered yet",
    lifecycle: "provisioning",
    inbound: false,
    outbound: false,
    number: { status: "provisioning", connection: true, inbound: false },
  },
  {
    id: "inbound_registered",
    label: "Inbound agent registered, deployment being verified (partial)",
    lifecycle: "provisioning",
    inbound: true,
    outbound: false,
    number: { status: "provisioning", connection: true, inbound: false },
  },
  {
    id: "verification_failed",
    label: "Deployment verification failed (number left inactive)",
    lifecycle: "provisioning",
    inbound: true,
    outbound: false,
    number: { status: "provisioning", connection: false, inbound: false },
  },
  {
    id: "inbound_live",
    label: "Retry succeeded: inbound live, outbound agent missing",
    lifecycle: "provisioning",
    inbound: true,
    outbound: false,
    number: { status: "active", connection: true, inbound: true },
  },
  {
    id: "ready",
    label: "Outbound agent registered: ready",
    lifecycle: "provisioning",
    inbound: true,
    outbound: true,
    number: { status: "active", connection: true, inbound: true },
  },
  {
    id: "handed_over",
    label: "Handed over (account active)",
    lifecycle: "active",
    inbound: true,
    outbound: true,
    number: { status: "active", connection: true, inbound: true },
  },
] as const;

export type Stage = (typeof STAGES)[number];
const KEY = "customer-status-harness-stage";

export function currentStage(): Stage {
  const id = localStorage.getItem(KEY);
  return STAGES.find((s) => s.id === id) ?? STAGES[0];
}
export function setStage(id: string) {
  localStorage.setItem(KEY, id);
}
