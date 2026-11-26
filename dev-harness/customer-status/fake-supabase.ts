/**
 * Harness only: stands in for @/integrations/supabase/client, so the REAL
 * workspace.ts / pricing.ts queries run unchanged against the simulated
 * backend in stages.ts. Supports exactly the builder calls those queries use
 * (select, eq, like, order, limit, maybeSingle, await). Every read is counted
 * on window.__reads.
 */
import { currentStage } from "./stages";

type Row = Record<string, unknown>;
const ORG = "org_demo";
const reads: string[] = [];
(window as unknown as { __reads: string[] }).__reads = reads;

function tables(): Record<string, Row[]> {
  const s = currentStage();
  const org: Row = {
    id: ORG,
    name: "Demo Dental",
    account_status: s.lifecycle === "active" ? "active" : "setup_in_progress",
    lifecycle_status: s.lifecycle,
    setup_paid_at: "2026-11-20T08:00:00Z",
    next_billing_at: null,
  };
  return {
    organization_members: [{ role: "owner", organization_id: ORG, organizations: org }],
    businesses: [{ id: "biz_demo", organization_id: ORG, name: "Demo Dental" }],
    subscriptions: [{ organization_id: ORG, plan: "Starter" }],
    agent_configs: [
      {
        id: "agent_demo",
        business_id: "biz_demo",
        organization_id: ORG,
        active_version: s.inbound ? 1 : 0,
        sarvam_app_id: s.inbound ? "Demo-in-1" : null,
        sarvam_app_version: s.inbound ? 1 : null,
        sarvam_outbound_app_id: s.outbound ? "Demo-out-1" : null,
        sarvam_outbound_app_version: s.outbound ? 1 : null,
        // Confirmed for calling unless the stage says the checks are still pending.
        sarvam_outbound_ready_app_id:
          s.outbound && !("outboundConfirmed" in s) ? "Demo-out-1" : null,
        sarvam_outbound_ready_version: s.outbound && !("outboundConfirmed" in s) ? 1 : null,
      },
    ],
    phone_numbers: s.number
      ? [
          {
            id: "num_demo",
            organization_id: ORG,
            e164: "+917900000099",
            status: s.number.status,
            connection_id: s.number.connection ? "conn_demo" : null,
            inbound_enabled: s.number.inbound,
            outbound_enabled: false,
            created_at: "2026-11-20T08:05:00Z",
          },
        ]
      : [],
    platform_settings: [],
  };
}

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let limit = Infinity;
  let single = false;
  const run = async () => {
    reads.push(table);
    await new Promise((r) => setTimeout(r, 60));
    const rows = (tables()[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit);
    return { data: single ? (rows[0] ?? null) : rows, error: null };
  };
  const b = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    like: (c: string, p: string) => {
      const prefix = p.replace(/%$/, "");
      filters.push((r) => String(r[c] ?? "").startsWith(prefix));
      return b;
    },
    limit: (n: number) => ((limit = n), b),
    maybeSingle: () => ((single = true), run()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
  };
  return b;
}

export const supabase = { from: builder };
