#!/usr/bin/env node
/**
 * Reads or sets ONLY the cron schedules of the production Worker `klyro`,
 * through Cloudflare's Workers schedules API. Unlike `wrangler triggers
 * deploy`, this never touches routes or the clickai.in / app.clickai.in
 * custom domains (those are managed in the Cloudflare dashboard, not in
 * wrangler.json).
 *
 *   node scripts/ops/klyro-cron.mjs status
 *   node scripts/ops/klyro-cron.mjs enable --yes    # "* * * * *": the job queue tick
 *   node scripts/ops/klyro-cron.mjs disable --yes   # no schedules: ticks stop
 *
 * Authenticates with the Wrangler OAuth login already on this machine
 * (run `npx wrangler whoami` first to refresh it). The token is never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCRIPT = "klyro";
const CRON = "* * * * *";
const [action = "status", ...flags] = process.argv.slice(2);

const configFile = [
  join(homedir(), ".wrangler", "config", "default.toml"),
  join(process.env.APPDATA ?? "", "xdg.config", ".wrangler", "config", "default.toml"),
  join(homedir(), ".config", ".wrangler", "config", "default.toml"),
]
  .filter(existsSync)
  .map((f) => ({ f, t: readFileSync(f, "utf8") }))
  .map(({ f, t }) => ({
    f,
    token: /oauth_token\s*=\s*"([^"]+)"/.exec(t)?.[1],
    exp: /expiration_time\s*=\s*"([^"]+)"/.exec(t)?.[1],
  }))
  .filter((c) => c.token)
  .sort((a, b) => String(b.exp).localeCompare(String(a.exp)))[0];
if (!configFile) {
  console.error("No Wrangler login found. Run `npx wrangler login` first.");
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${configFile.token}`, "Content-Type": "application/json" },
  });
  const body = await res.json();
  if (!body.success) {
    console.error(
      `Cloudflare API error ${res.status}: ${(body.errors ?? []).map((e) => e.message).join("; ")}`,
    );
    process.exit(1);
  }
  return body.result;
}

const accounts = await api("/accounts");
if (accounts.length !== 1) {
  console.error(`Expected one Cloudflare account, found ${accounts.length}.`);
  process.exit(1);
}
const base = `/accounts/${accounts[0].id}/workers/scripts/${SCRIPT}/schedules`;
const show = (r) =>
  console.log(
    `${SCRIPT} cron schedules: ${JSON.stringify((r.schedules ?? []).map((s) => s.cron))}`,
  );

if (action === "status") {
  show(await api(base));
} else if (action === "enable" || action === "disable") {
  if (!flags.includes("--yes")) {
    console.error(`${action} changes production; re-run with --yes.`);
    process.exit(1);
  }
  show(
    await api(base, {
      method: "PUT",
      body: JSON.stringify(action === "enable" ? [{ cron: CRON }] : []),
    }),
  );
} else {
  console.error("usage: klyro-cron.mjs status | enable --yes | disable --yes");
  process.exit(1);
}
