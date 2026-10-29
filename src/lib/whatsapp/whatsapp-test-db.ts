/**
 * Test-only in-memory stand-in for the Supabase query builder, covering the
 * subset the WhatsApp modules use (select/insert/upsert/update/delete, eq,
 * neq, in, is, not-is, gte/lte/gt/lt, the `or(a.is.null,a.lt."x")` form,
 * order, limit, single/maybeSingle, count-head and `col->>key` paths).
 * Unique constraints mirror the real schema so duplicate and race paths
 * produce the same 23505 errors PostgREST would. Not imported by app code.
 */
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type DbError = { code: string; message: string };
type Result = { data: unknown; error: DbError | null; count?: number | null };

/**
 * Unique keys per table; `partial` keys ignore rows where any column is null
 * (like a partial index), `where` limits the key to matching rows.
 */
const LIVE_STATUSES = new Set(["queued", "sent", "delivered", "read"]);
const UNIQUE_KEYS: Record<
  string,
  { cols: string[]; partial?: boolean; where?: (row: Row) => boolean }[]
> = {
  webhook_events: [{ cols: ["provider", "event_id"] }],
  payment_webhook_events: [{ cols: ["provider", "event_id"] }],
  payment_requests: [
    { cols: ["idempotency_key"] },
    {
      cols: ["booking_id"],
      where: (r) => ["CREATED", "PENDING", "CAPTURED"].includes(String(r["status"])),
    },
  ],
  whatsapp_conversations: [{ cols: ["whatsapp_connection_id", "wa_id"] }],
  whatsapp_messages: [
    { cols: ["whatsapp_connection_id", "wa_message_id"], partial: true },
    { cols: ["reply_to_message_id"], partial: true },
    {
      cols: ["whatsapp_connection_id", "metadata->>idempotency_key"],
      partial: true,
      where: (r) => LIVE_STATUSES.has(String(r["status"])),
    },
  ],
  whatsapp_connections: [
    { cols: ["phone_number_id"], partial: true, where: (r) => r["status"] !== "disconnected" },
    { cols: ["vobiz_channel_id"], partial: true, where: (r) => r["status"] !== "disconnected" },
  ],
  whatsapp_number_orders: [
    {
      cols: ["organization_id", "phone_number"],
      where: (r) => ["requested", "pending", "completed", "unknown"].includes(String(r["status"])),
    },
    { cols: ["vobiz_order_id"], partial: true },
  ],
  whatsapp_notifications: [{ cols: ["dedupe_key"] }],
  whatsapp_campaign_recipients: [{ cols: ["campaign_id", "wa_id"] }],
  whatsapp_suppressions: [{ cols: ["business_id", "wa_id"] }],
  whatsapp_templates: [{ cols: ["whatsapp_connection_id", "name", "language"] }],
  whatsapp_pending_actions: [
    {
      cols: ["conversation_id"],
      where: (r) => r["status"] === "awaiting_confirmation",
    },
  ],
};

const DEFAULTS: Record<string, (nowIso: string) => Row> = {
  whatsapp_conversations: () => ({
    ai_enabled: true,
    handoff_requested_at: null,
    last_inbound_at: null,
    last_message_at: null,
    last_message_preview: null,
    contact_id: null,
    status: "open",
  }),
  whatsapp_messages: () => ({
    attempts: 0,
    reply_to_message_id: null,
    wa_message_id: null,
    content: null,
    error_message: null,
    contact_id: null,
    metadata: {},
  }),
  whatsapp_notifications: (nowIso) => ({
    status: "pending",
    attempts: 0,
    next_attempt_at: nowIso,
    locked_at: null,
    skip_reason: null,
    last_error: null,
    whatsapp_message_id: null,
    sent_at: null,
    payload: {},
    booking_id: null,
    payment_request_id: null,
  }),
  whatsapp_campaign_recipients: (nowIso) => ({
    status: "pending",
    attempts: 0,
    next_attempt_at: nowIso,
    locked_at: null,
    skip_reason: null,
    error: null,
    whatsapp_message_id: null,
    sent_at: null,
    contact_id: null,
  }),
  whatsapp_campaigns: () => ({
    status: "draft",
    template_params: [],
    audience: { type: "all_consented" },
    schedule: {},
    scheduled_at: null,
    paused_reason: null,
    max_per_minute: 20,
    launched_at: null,
    completed_at: null,
  }),
  whatsapp_pending_actions: () => ({
    status: "awaiting_confirmation",
    result: null,
    error: null,
    proposed_in_message_id: null,
    decided_by_message_id: null,
  }),
  whatsapp_templates: () => ({ purpose: null, body_param_count: 0, meta_template_id: null }),
};

function read(row: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) {
    const obj = row[m[1]!] as Row | null | undefined;
    const v = obj?.[m[2]!];
    return v === undefined || v === null ? null : String(v);
  }
  return row[col] ?? null;
}

type Pred = (row: Row) => boolean;

export interface FakeDbOptions {
  now?: () => Date;
  /** Return an error to make the matching operation fail (e.g. inject a DB outage). */
  failWhen?: (
    table: string,
    op: "select" | "insert" | "upsert" | "update" | "delete",
  ) => DbError | null;
  /** Like PostgREST's max-rows: a select returns at most this many rows (silently). */
  maxRows?: number;
}

export function createFakeDb(seed: Record<string, Row[]> = {}, options: FakeDbOptions = {}) {
  const tables: Record<string, Row[]> = {};
  const now = options.now ?? (() => new Date());
  const log: { table: string; op: string }[] = [];

  function table(name: string): Row[] {
    return (tables[name] ??= []);
  }

  function withDefaults(name: string, row: Row): Row {
    return {
      id: randomUUID(),
      created_at: now().toISOString(),
      ...(DEFAULTS[name]?.(now().toISOString()) ?? {}),
      ...row,
    };
  }

  function uniqueViolation(name: string, candidate: Row, ignore?: Row): boolean {
    for (const key of UNIQUE_KEYS[name] ?? []) {
      if (key.where && !key.where(candidate)) continue;
      const values = key.cols.map((c) => read(candidate, c));
      if (key.partial && values.some((v) => v === null)) continue;
      const clash = table(name).some(
        (r) =>
          r !== ignore &&
          (!key.where || key.where(r)) &&
          key.cols.every((c, i) => read(r, c) === values[i]),
      );
      if (clash) return true;
    }
    return false;
  }

  const DUP: DbError = { code: "23505", message: "duplicate key value violates unique constraint" };

  for (const [name, rows] of Object.entries(seed)) {
    for (const row of rows) table(name).push(withDefaults(name, row));
  }

  function builder(
    name: string,
    op: "select" | "insert" | "upsert" | "update" | "delete",
    payload?: unknown,
    opts?: Record<string, unknown>,
  ) {
    const preds: Pred[] = [];
    const orders: { col: string; asc: boolean }[] = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let returning = op === "select";
    let countHead = false;
    let mode: "many" | "single" | "maybeSingle" = "many";

    const run = (): Result => {
      log.push({ table: name, op });
      const injected = options.failWhen?.(name, op);
      if (injected) return { data: null, error: injected };
      let affected: Row[] = [];
      if (op === "select") {
        affected = table(name).filter((r) => preds.every((p) => p(r)));
      } else if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
        for (const r of rows) {
          const full = withDefaults(name, r);
          if (uniqueViolation(name, full)) return { data: null, error: DUP };
          table(name).push(full);
          affected.push(full);
        }
      } else if (op === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const cols = String(opts?.["onConflict"] ?? "id").split(",");
        for (const row of rows) {
          const existing = table(name).find((r) => cols.every((c) => r[c] === row[c]));
          if (existing) {
            if (opts?.["ignoreDuplicates"] !== true) Object.assign(existing, row);
            affected.push(existing);
          } else {
            const full = withDefaults(name, row);
            if (uniqueViolation(name, full)) return { data: null, error: DUP };
            table(name).push(full);
            affected.push(full);
          }
        }
      } else if (op === "update") {
        const matches = table(name).filter((r) => preds.every((p) => p(r)));
        for (const r of matches) {
          if (uniqueViolation(name, { ...r, ...(payload as Row) }, r))
            return { data: null, error: DUP };
        }
        for (const r of matches) Object.assign(r, payload as Row);
        affected = matches;
      } else if (op === "delete") {
        affected = table(name).filter((r) => preds.every((p) => p(r)));
        tables[name] = table(name).filter((r) => !affected.includes(r));
      }

      if (orders.length > 0) {
        affected = [...affected].sort((a, b) => {
          for (const { col, asc } of orders) {
            const x = String(read(a, col) ?? "");
            const y = String(read(b, col) ?? "");
            const c = asc ? x.localeCompare(y) : y.localeCompare(x);
            if (c !== 0) return c;
          }
          return 0;
        });
      }
      if (range) affected = affected.slice(range[0], range[1] + 1);
      if (limit !== null) affected = affected.slice(0, limit);
      if (op === "select" && options.maxRows !== undefined && !countHead) {
        affected = affected.slice(0, options.maxRows);
      }
      if (countHead) return { data: null, error: null, count: affected.length };
      if (!returning) return { data: null, error: null };
      const copies = affected.map((r) => structuredClone(r));
      if (mode === "single") {
        return copies.length === 1
          ? { data: copies[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "not exactly one row" } };
      }
      if (mode === "maybeSingle") {
        if (copies.length > 1)
          return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        return { data: copies[0] ?? null, error: null };
      }
      return { data: copies, error: null };
    };

    const chain = {
      select(_cols?: string, selectOpts?: { count?: string; head?: boolean }) {
        returning = true;
        if (selectOpts?.head) countHead = true;
        return chain;
      },
      eq(col: string, v: unknown) {
        preds.push((r) => read(r, col) === v);
        return chain;
      },
      neq(col: string, v: unknown) {
        preds.push((r) => read(r, col) !== v);
        return chain;
      },
      in(col: string, vs: unknown[]) {
        preds.push((r) => vs.includes(read(r, col)));
        return chain;
      },
      is(col: string, v: null) {
        preds.push((r) => read(r, col) === v);
        return chain;
      },
      not(col: string, operator: string, v: unknown) {
        if (operator !== "is" || v !== null)
          throw new Error(`fake db: unsupported not(${operator})`);
        preds.push((r) => read(r, col) !== null);
        return chain;
      },
      gte(col: string, v: string) {
        preds.push((r) => read(r, col) !== null && String(read(r, col)) >= v);
        return chain;
      },
      lte(col: string, v: string) {
        preds.push((r) => read(r, col) !== null && String(read(r, col)) <= v);
        return chain;
      },
      gt(col: string, v: string) {
        preds.push((r) => read(r, col) !== null && String(read(r, col)) > v);
        return chain;
      },
      lt(col: string, v: string) {
        preds.push((r) => read(r, col) !== null && String(read(r, col)) < v);
        return chain;
      },
      or(expr: string) {
        const alternatives = expr.split(/,(?=\w+\.)/).map((part): Pred => {
          const m = /^(\w+)\.(is|lt|gt|eq)\.(.*)$/.exec(part);
          if (!m) throw new Error(`fake db: unsupported or() term ${part}`);
          const [, col, operator, rawValue] = m;
          const value = rawValue!.replace(/^"(.*)"$/, "$1");
          return (r) => {
            const cell = read(r, col!);
            if (operator === "is") return value === "null" ? cell === null : false;
            if (cell === null) return false;
            if (operator === "eq") return String(cell) === value;
            // ISO timestamps compare correctly as strings once normalised.
            const a = new Date(String(cell)).getTime();
            const b = new Date(value).getTime();
            return operator === "lt" ? a < b : operator === "gt" ? a > b : a === b;
          };
        });
        preds.push((r) => alternatives.some((p) => p(r)));
        return chain;
      },
      order(col: string, o?: { ascending?: boolean }) {
        orders.push({ col, asc: o?.ascending !== false });
        return chain;
      },
      range(from: number, to: number) {
        range = [from, to];
        return chain;
      },
      limit(n: number) {
        limit = n;
        return chain;
      },
      single() {
        mode = "single";
        returning = true;
        return Promise.resolve(run());
      },
      maybeSingle() {
        mode = "maybeSingle";
        returning = true;
        return Promise.resolve(run());
      },
      then<T>(resolve: (v: Result) => T, reject?: (e: unknown) => T) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return chain;
  }

  /** Mirrors public.enqueue_whatsapp_notification (20261020090000). */
  function enqueueNotification(args: Record<string, unknown>): Result {
    const enabled = table("whatsapp_connections").some(
      (c) =>
        c["business_id"] === args["p_business_id"] &&
        c["status"] === "connected" &&
        c["notifications_enabled"] === true,
    );
    if (!enabled) return { data: null, error: null };
    if (table("whatsapp_notifications").some((n) => n["dedupe_key"] === args["p_dedupe_key"])) {
      return { data: null, error: null };
    }
    table("whatsapp_notifications").push(
      withDefaults("whatsapp_notifications", {
        organization_id: args["p_organization_id"],
        business_id: args["p_business_id"],
        booking_id: args["p_booking_id"] ?? null,
        payment_request_id: args["p_payment_request_id"] ?? null,
        kind: args["p_kind"],
        dedupe_key: args["p_dedupe_key"],
        payload: args["p_payload"] ?? {},
      }),
    );
    return { data: null, error: null };
  }

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      log.push({ table: `rpc:${name}`, op: "rpc" });
      if (name === "enqueue_whatsapp_notification")
        return Promise.resolve(enqueueNotification(args));
      return Promise.resolve({
        data: null,
        error: { code: "42883", message: `fake db: no rpc ${name}` },
      });
    },
    from(name: string) {
      return {
        select: (cols?: string, o?: { count?: string; head?: boolean }) =>
          builder(name, "select").select(cols, o),
        insert: (payload: unknown) => builder(name, "insert", payload),
        upsert: (payload: unknown, o?: Record<string, unknown>) =>
          builder(name, "upsert", payload, o),
        update: (payload: unknown) => builder(name, "update", payload),
        delete: () => builder(name, "delete"),
      };
    },
  };

  return {
    client: client as never,
    rows: (name: string) => table(name),
    log,
  };
}
