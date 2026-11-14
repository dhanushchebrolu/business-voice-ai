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
    let mode: "many" | "single" | "maybeSingle" = "many";

    const rows = () => (tables[table] ??= []);

    function run(): { data: unknown; error: unknown } {
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
        result = matched;
      }
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
      select() {
        if (op !== "select") returning = true;
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
        filters.push((r) => r[col] === v);
        return b;
      },
      neq(col: string, v: unknown) {
        filters.push((r) => r[col] !== v);
        return b;
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]));
        return b;
      },
      is(col: string, v: unknown) {
        filters.push((r) => (r[col] ?? null) === v);
        return b;
      },
      order() {
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
