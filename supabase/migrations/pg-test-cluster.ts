import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shared disposable-PostgreSQL-cluster bootstrap, used by both
 * business_hours_interval_validation.pg.test.ts and its harness
 * self-test (business_hours_interval_validation.harness-selftest.
 * pg.test.ts) so the two files exercise exactly the same bootstrap path
 * instead of drifting copies.
 *
 * This module only ever creates a brand-new cluster in its own throwaway
 * temp directory, reachable only over a Unix-domain socket inside that
 * same directory, and never touches any shared or production database.
 *
 * `bootstrapCluster()` separates two kinds of failure on purpose:
 *   - Anything before the cluster is actually up and listening (no
 *     PostgreSQL install found, no `postgres` OS user to de-escalate to
 *     when running as root, or a failure in the mechanical steps of
 *     standing the cluster up — temp-dir creation, chown, initdb,
 *     pg_ctl start) is a genuine statement about THIS environment, not
 *     about any SQL under test. Callers report these as a skip.
 *   - Once `bootstrapCluster()` returns `ok: true`, PostgreSQL is
 *     definitively available. Any later failure to load or run SQL
 *     against it (e.g. a caller's own migration-under-test failing to
 *     load) is real, and callers must report it as a test failure, not
 *     fold it back into a skip.
 */

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Cluster {
  workDir: string;
  dataDir: string;
  sockDir: string;
  pgBinDir: string;
  useSu: boolean;
}

export type BootstrapResult = { ok: true; cluster: Cluster } | { ok: false; reason: string };

const PG_BIN_CANDIDATES = [
  "",
  "/usr/lib/postgresql/17/bin/",
  "/usr/lib/postgresql/16/bin/",
  "/usr/lib/postgresql/15/bin/",
  "/usr/lib/postgresql/14/bin/",
  "/opt/homebrew/opt/postgresql@16/bin/",
  "/usr/local/opt/postgresql@16/bin/",
];

/** Looks for psql, initdb, AND pg_ctl together — a partial install (e.g. client tools only) is not usable. */
export function findPgBinDir(): string | null {
  for (const dir of PG_BIN_CANDIDATES) {
    try {
      execFileSync(`${dir}psql`, ["--version"], { stdio: "ignore" });
      execFileSync(`${dir}initdb`, ["--version"], { stdio: "ignore" });
      execFileSync(`${dir}pg_ctl`, ["--version"], { stdio: "ignore" });
      return dir;
    } catch {
      continue;
    }
  }
  return null;
}

export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export interface PostgresUserCheck {
  exists: boolean;
  checkFailed: boolean;
  detail: string;
}

/**
 * Checks for the `postgres` OS user via `getent passwd` first, falling
 * back to `id` only if `getent` itself can't be run. Both lookups are
 * still subject to a restricted $PATH hiding the lookup command itself
 * (not Postgres) — when that happens this reports `checkFailed: true`
 * with a named reason, rather than silently reading as "no postgres
 * user exists" the way a single `id`-only check would.
 */
export function postgresUserExists(): PostgresUserCheck {
  const attempts: Array<[string, string[]]> = [
    ["getent", ["passwd", "postgres"]],
    ["id", ["postgres"]],
  ];
  for (const [cmd, args] of attempts) {
    const result = spawnSync(cmd, args, { stdio: "ignore" });
    const notFound = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    if (notFound) continue;
    return {
      exists: result.status === 0,
      checkFailed: false,
      detail: `${cmd} ${args.join(" ")} -> status ${result.status}`,
    };
  }
  return {
    exists: false,
    checkFailed: true,
    detail:
      "neither 'getent' nor 'id' could be executed (both missing from PATH) — cannot determine whether a postgres OS user exists",
  };
}

/** Runs a shell command either directly, or as the `postgres` OS user when this process is root. */
export function runCmd(cmd: string, args: string[], useSu: boolean): RunResult {
  const result = useSu
    ? spawnSync("su", ["postgres", "-c", [cmd, ...args].join(" ")], { encoding: "utf8" })
    : spawnSync(cmd, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Builds an execSql(sql) closure bound to one bootstrapped cluster. */
export function makeExecSql(cluster: Pick<Cluster, "pgBinDir" | "sockDir" | "useSu">) {
  return function execSql(sql: string): RunResult {
    const args = [
      "-h",
      cluster.sockDir,
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-X",
      "-f",
      "-",
    ];
    const result = cluster.useSu
      ? spawnSync("su", ["postgres", "-c", [`${cluster.pgBinDir}psql`, ...args].join(" ")], {
          input: sql,
          encoding: "utf8",
        })
      : spawnSync(`${cluster.pgBinDir}psql`, args, { input: sql, encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/**
 * Brings up a brand-new, disposable PostgreSQL cluster. Returns
 * `{ ok: true, cluster }` once it is listening on its own Unix-domain
 * socket, or `{ ok: false, reason }` when this environment genuinely
 * cannot host one. See the module doc comment for why everything here is
 * skip-worthy but nothing after it is.
 */
export function bootstrapCluster(): BootstrapResult {
  const pgBinDir = findPgBinDir();
  if (!pgBinDir) {
    return {
      ok: false,
      reason:
        "no PostgreSQL installation (psql/initdb/pg_ctl) found on PATH or in common install locations",
    };
  }

  let useSu = false;
  if (isRoot()) {
    const userCheck = postgresUserExists();
    if (userCheck.checkFailed) {
      return {
        ok: false,
        reason: `running as root, and could not determine whether a 'postgres' OS user exists (${userCheck.detail}) — treating as unavailable rather than guessing`,
      };
    }
    if (!userCheck.exists) {
      return {
        ok: false,
        reason: "running as root and no 'postgres' OS user exists to run initdb/psql as",
      };
    }
    useSu = true;
  }

  let workDir: string;
  let dataDir: string;
  let sockDir: string;
  try {
    workDir = mkdtempSync(join(tmpdir(), "bhv-pg-test-"));
    dataDir = join(workDir, "data");
    sockDir = join(workDir, "sock");
    // Created directly by this (possibly root) process, not via su — the
    // postgres OS user doesn't yet have access to workDir, so it couldn't
    // create subdirectories here even if asked to. chown below hands the
    // whole tree over before postgres touches anything in it.
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(sockDir, { recursive: true });
    chmodSync(workDir, 0o755);
  } catch (err) {
    return {
      ok: false,
      reason: `could not create or prepare the disposable cluster's temp directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (useSu) {
    const chownResult = spawnSync("chown", ["-R", "postgres:postgres", workDir], {
      encoding: "utf8",
    });
    if (chownResult.status !== 0) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      return {
        ok: false,
        reason: `could not chown the disposable cluster directory to postgres: ${chownResult.stderr}`,
      };
    }
  }

  const initResult = runCmd(
    `${pgBinDir}initdb`,
    ["-D", dataDir, "--auth=trust", "-U", "postgres"],
    useSu,
  );
  if (initResult.status !== 0) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return { ok: false, reason: `initdb failed: ${initResult.stderr}` };
  }

  const startResult = runCmd(
    `${pgBinDir}pg_ctl`,
    ["-D", dataDir, "-o", `"-k ${sockDir} -h ''"`, "-l", join(workDir, "log.txt"), "start"],
    useSu,
  );
  if (startResult.status !== 0) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return { ok: false, reason: `pg_ctl start failed: ${startResult.stderr}` };
  }

  return { ok: true, cluster: { workDir, dataDir, sockDir, pgBinDir, useSu } };
}

/** Stops the cluster and removes its temp directory. Best-effort: a leftover /tmp dir is not worth failing a suite over. */
export function teardownCluster(cluster: Cluster): void {
  runCmd(
    `${cluster.pgBinDir}pg_ctl`,
    ["-D", cluster.dataDir, "stop", "-m", "immediate"],
    cluster.useSu,
  );
  try {
    rmSync(cluster.workDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Registers SIGINT/SIGTERM handlers that tear the cluster down before
 * exiting, for the common catchable-termination case (Ctrl-C, a CI job
 * cancellation sent as SIGTERM). This cannot and does not claim to help
 * with SIGKILL — a process killed with SIGKILL gets no handler at all,
 * by design of the signal itself, so an orphaned cluster in that specific
 * case is a known, documented limitation rather than something this
 * function silently fails to cover.
 */
export function registerSignalCleanup(getCluster: () => Cluster | null): () => void {
  const handler = (signal: NodeJS.Signals) => {
    const cluster = getCluster();
    if (cluster) {
      teardownCluster(cluster);
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
  };
}
