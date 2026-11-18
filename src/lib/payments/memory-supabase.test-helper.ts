/**
 * A tiny in-memory stand-in for the supabase-js query builder, for
 * behavioral tests: insert / select / update with eq / neq / in filters,
 * single / maybeSingle, unique constraints (reported as Postgres 23505) and
 * scripted rpc functions. Only what the provisioning and webhook code uses.
 */

type Row = Record<string, unknown>;
type Unique = { table: string; key: (r: Row) => string | null };
type Filter = (r: Row) => boolean;

export interface MemoryDb {
  tables: Record<string, Row[]>;
  client: never;
  /** Makes the next write to `table` fail with this error. */
  failNext(table: string, op: "insert" | "update", error: { code?: string; message: string }): void;
}

/** A row's value for a column or a PostgREST JSON path (`col->key`, `col->>key`). */
function field(r: Row, col: string): unknown {
  const m = /^([^-]+)->>?(.+)$/.exec(col);
  if (!m) return r[col];
  const base = r[m[1]!];
  const v =
    base && typeof base === "object" && !Array.isArray(base) ? (base as Row)[m[2]!] : undefined;
  if (col.includes("->>") && v !== undefined && v !== null && typeof v === "object")
    return JSON.stringify(v);
  return v;
}

export function memorySupabase(opts: {
  tables?: Record<string, Row[]>;
  uniques?: Unique[];
  rpc?: Record<string, (args: Row, db: Record<string, Row[]>) => unknown>;
}): MemoryDb {
  const tables: Record<string, Row[]> = opts.tables ?? {};
  const failures: Record<string, { code?: string; message: string }> = {};
  let seq = 0;

  function builder(table: string) {
    const filters: Filter[] = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    let returning = false;
    let mode: "many" | "single" | "maybeSingle" | "count" = "many";
    let limit = Number.POSITIVE_INFINITY;
    const ordering: { col: string; ascending: boolean }[] = [];

    const rows = () => (tables[table] ??= []);

    function run(): { data: unknown; error: unknown; count?: number } {
      const failKey = `${table}:${op}`;
      if (op !== "select" && failures[failKey]) {
        const error = failures[failKey];
        delete failures[failKey];
        return { data: null, error };
      }
      let result: Row[] = [];
      if (op === "insert") {
        const row: Row = {
          id: `id_${++seq}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...payload,
        };
        for (const u of opts.uniques ?? []) {
          if (u.table !== table) continue;
          const k = u.key(row);
          if (k !== null && rows().some((r) => u.key(r) === k))
            return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        rows().push(row);
        result = [row];
      } else {
        const matched = rows().filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of matched)
            Object.assign(r, payload, { updated_at: new Date().toISOString() });
        }
        if (op === "select" && ordering.length > 0)
          matched.sort((x, y) => {
            for (const o of ordering) {
              const a = field(x, o.col);
              const c = field(y, o.col);
              if (a === c) continue;
              const cmp = String(a ?? "") < String(c ?? "") ? -1 : 1;
              return o.ascending ? cmp : -cmp;
            }
            return 0;
          });
        result = op === "select" ? matched.slice(0, limit) : matched;
      }
      if (mode === "count") return { data: null, count: result.length, error: null };
      if (op !== "select" && !returning) return { data: null, error: null };
      const copy = result.map((r) => ({ ...r }));
      if (mode === "single")
        return copy.length === 1
          ? { data: copy[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "not exactly one row" } };
      if (mode === "maybeSingle") return { data: copy[0] ?? null, error: null };
      return { data: copy, error: null };
    }

    const b = {
      select(_columns?: string, options?: { count?: string; head?: boolean }) {
        if (op !== "select") returning = true;
        if (options?.head) mode = "count";
        return b;
      },
      limit(n: number) {
        limit = n;
        return b;
      },
      /** PostgREST `or`: comma-separated `column.op.value`, ops is/not.is/eq/lte/gte. */
      or(expression: string) {
        const parts = expression.split(",").map((p) => {
          const [col, first, ...rest] = p.split(".");
          const negated = first === "not";
          const operator = negated ? rest.shift() : first;
          const value = rest.join(".");
          return (r: Row) => {
            const v = field(r, col!);
            if (operator === "is" && negated) return (v ?? null) !== null;
            if (operator === "is") return value === "null" ? (v ?? null) === null : false;
            if (operator === "eq") return String(v) === value;
            if (operator === "lte") return v != null && String(v) <= value;
            if (operator === "gte") return v != null && String(v) >= value;
            throw new Error(`memory-supabase: unsupported or() operator ${operator}`);
          };
        });
        filters.push((r) => parts.some((f) => f(r)));
        return b;
      },
      insert(p: Row) {
        op = "insert";
        payload = p;
        return b;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return b;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => field(r, col) === v);
        return b;
      },
      neq(col: string, v: unknown) {
        filters.push((r) => field(r, col) !== v);
        return b;
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(field(r, col)));
        return b;
      },
      is(col: string, v: unknown) {
        filters.push((r) => (field(r, col) ?? null) === v);
        return b;
      },
      /** Only `not(col, "is", null)` is supported. */
      not(col: string, operator: string, v: unknown) {
        if (operator !== "is" || v !== null)
          throw new Error(`memory-supabase: unsupported not(${operator})`);
        filters.push((r) => (field(r, col) ?? null) !== null);
        return b;
      },
      lt(col: string, v: string) {
        filters.push((r) => field(r, col) != null && String(field(r, col)) < v);
        return b;
      },
      lte(col: string, v: string) {
        filters.push((r) => field(r, col) != null && String(field(r, col)) <= v);
        return b;
      },
      gt(col: string, v: string) {
        filters.push((r) => field(r, col) != null && String(field(r, col)) > v);
        return b;
      },
      order(col: string, options?: { ascending?: boolean }) {
        ordering.push({ col, ascending: options?.ascending !== false });
        return b;
      },
      single() {
        mode = "single";
        return b;
      },
      maybeSingle() {
        mode = "maybeSingle";
        return b;
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return b;
  }

  const client = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Row) => {
      const fn = opts.rpc?.[name];
      if (!fn) return { data: null, error: { message: `no rpc ${name}` } };
      try {
        return { data: fn(args, tables), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };

  return {
    tables,
    client: client as never,
    failNext(table, op, error) {
      failures[`${table}:${op}`] = error;
    },
  };
}
