/**
 * The clickai-staging deploy sequence, with its command runner injected so
 * staging.test.mjs can check it without building or deploying anything.
 *
 * A brand-new Worker can't have secrets set before it exists, and
 * wrangler.json marks SUPABASE_SERVICE_ROLE_KEY as required, so the first
 * deploy must carry its secrets: `wrangler deploy --secrets-file` uploads
 * them with that version (additively — secrets it omits are kept).
 *
 * The secrets file holds only the server secrets, lives in its own
 * private temporary directory, and is removed in a `finally` block whether
 * the deploy succeeds, fails or throws. Nothing here prints a value.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STAGING_WORKER = "clickai-staging";

/** The server secrets for the Worker: every required one, plus optional ones that are set. */
export function serverSecrets(env, required, optional) {
  const missing = required.filter((n) => !env[n]);
  if (missing.length > 0) throw new Error(`missing server secrets: ${missing.join(", ")}`);
  return Object.fromEntries(
    [...required, ...optional.filter((n) => env[n])].map((n) => [n, env[n]]),
  );
}

const PRODUCTION_SUPABASE_REF = "eorazvlmqwunmhwviocn";

/**
 * What else a generated config must not carry: routes or a custom domain
 * (staging lives on its workers.dev URL only), Wrangler environments, or
 * anything naming production.
 */
export function generatedConfigProblems(generated) {
  const problems = [];
  for (const key of ["routes", "route", "env"]) {
    if (generated?.[key] !== undefined) problems.push(`it sets "${key}"`);
  }
  const text = JSON.stringify(generated ?? {});
  if (text.includes(PRODUCTION_SUPABASE_REF)) problems.push("it mentions the production project");
  if (/klyro/.test(text)) problems.push("it mentions the production Worker klyro");
  return problems;
}

/** npx arguments for the deploy: always the staging Worker, with the secrets file. */
export function wranglerDeployArgs(secretsFile) {
  return [
    "--no-install",
    "wrangler",
    "deploy",
    "--name",
    STAGING_WORKER,
    "--secrets-file",
    secretsFile,
  ];
}

/**
 * Builds for staging, checks the generated config names clickai-staging,
 * then deploys with the server secrets. `run(cmd, args, extraEnv)` returns an
 * exit code; it never exits the process, so cleanup always happens.
 */
export function deployStaging({
  env,
  required,
  optional,
  buildEnv,
  run,
  readGeneratedConfig,
  tmpRoot,
  log = console.log,
}) {
  // Fail before building if a secret is missing.
  const secrets = serverSecrets(env, required, optional);

  const built = run("npx", ["--no-install", "vite", "build"], {
    ...buildEnv,
    CLICKAI_DEPLOY_TARGET: "staging",
  });
  if (built !== 0) throw new Error(`vite build exited with ${built}`);
  const generated = readGeneratedConfig();
  // Exactly clickai-staging — never the production Worker, never anything else.
  if (generated?.name !== STAGING_WORKER) {
    throw new Error(`the build generated "${generated?.name}", not ${STAGING_WORKER}`);
  }
  const problems = generatedConfigProblems(generated);
  if (problems.length > 0) throw new Error(`the generated config: ${problems.join("; ")}`);

  const dir = mkdtempSync(join(tmpRoot, "clickai-staging-"));
  let deployed;
  try {
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    deployed = run("npx", wranglerDeployArgs(file), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (deployed !== 0) throw new Error(`wrangler deploy exited with ${deployed}`);
  log(
    `deployed ${STAGING_WORKER} with ${Object.keys(secrets).length} secrets ` +
      `(${Object.keys(secrets).join(", ")}; values not shown)`,
  );
  return { secretNames: Object.keys(secrets) };
}
