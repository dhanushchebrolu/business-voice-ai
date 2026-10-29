import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { findPgBinDir, pgBinCandidates, pgCtlStartArgs, shellQuote } from "./pg-test-cluster.ts";

/**
 * Where the bootstrap finds the server binaries. Ubuntu installs them under
 * /usr/lib/postgresql/<major>/bin, off PATH, and runner images move to new
 * major versions (PostgreSQL 18 on Ubuntu 26.04): a missed version makes
 * every PostgreSQL test skip, which CI then fails on.
 */
describe("finding the PostgreSQL server binaries", () => {
  test("PATH first, then every installed /usr/lib/postgresql version newest first (18 included), then Homebrew", () => {
    const candidates = pgBinCandidates(() => ["16", "18", "9", "notes", "17.6"]);
    assert.deepEqual(candidates.slice(0, 4), [
      "",
      "/usr/lib/postgresql/18/bin/",
      "/usr/lib/postgresql/16/bin/",
      "/usr/lib/postgresql/9/bin/",
    ]);
    assert.ok(
      candidates
        .slice(4)
        .every((dir) => dir.includes("homebrew") || dir.includes("/usr/local/opt/")),
    );
  });

  test("with nothing under /usr/lib/postgresql, only PATH and Homebrew are tried", () => {
    assert.deepEqual(pgBinCandidates(() => [])[0], "");
    assert.ok(pgBinCandidates(() => []).every((dir) => !dir.startsWith("/usr/lib/postgresql/")));
  });

  test("a directory without all three of psql, initdb and pg_ctl is not a PostgreSQL install", () => {
    assert.equal(findPgBinDir(["/nonexistent-postgresql-dir/bin/"]), null);
  });
});

/**
 * The disposable-cluster bootstrap runs pg_ctl two ways: directly (CI runs
 * as an ordinary user) or through `su postgres -c "<one shell string>"`
 * (running as root). Both must hand pg_ctl the same arguments, or the
 * cluster starts on one and not the other.
 */
describe("pg-test-cluster argument handling", () => {
  test("pg_ctl's -o value has no literal quotes (passed directly, they'd reach the server's -k)", () => {
    const args = pgCtlStartArgs("/tmp/x/data", "/tmp/x/sock", "/tmp/x/log.txt");
    const o = args[args.indexOf("-o") + 1];
    assert.equal(o, "-k /tmp/x/sock -h ''");
    assert.deepEqual(args.slice(-1), ["start"]);
  });

  // shellQuote only feeds `su postgres -c`, a POSIX-only path; native
  // Windows has no /bin/sh to round-trip through.
  test(
    "shellQuote round-trips every argument unchanged through /bin/sh (the su path)",
    {
      skip: process.platform === "win32" ? "POSIX-only: no /bin/sh on Windows" : false,
    },
    () => {
      const args = [
        "-k /tmp/x/sock -h ''",
        "plain",
        "with space",
        "it's",
        '"double"',
        "$HOME `x` \\ ;|&",
        "",
      ];
      const command = ["printf", "%s\\0", ...args].map(shellQuote).join(" ");
      const out = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(out.stdout.split("\0").slice(0, -1), args);
    },
  );
});
