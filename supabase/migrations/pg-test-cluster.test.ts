import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pgCtlStartArgs, shellQuote } from "./pg-test-cluster.ts";

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

  test("shellQuote round-trips every argument unchanged through /bin/sh (the su path)", () => {
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
  });
});
