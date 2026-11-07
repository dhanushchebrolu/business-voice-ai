/**
 * Static checks of the LOCAL self-hosted LiveKit stack
 * (deploy/docker-compose.dev.yml, deploy/local/*). No Docker needed: these
 * guard the configuration itself (pinned images, private Redis, no secrets
 * in committed files, Sarvam-only LLM, health checks, consistent ports).
 * The live checks are deploy/local/smoke.ts (npm run local:smoke).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { llm } from "@livekit/agents";
import { loadConfig } from "../src/runtime/config.ts";
import { buildLlm } from "../src/worker.ts";
import { ProvisionError, sipApiUrl } from "../deploy/livekit/sip-provisioning.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(join(root, "deploy/docker-compose.dev.yml"), "utf8");
const envExample = readFileSync(join(root, "deploy/local/.env.example"), "utf8");
const initEnv = readFileSync(join(root, "deploy/local/init-env.sh"), "utf8");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

/** The text of one top-level service (2-space indent) or top-level key. */
function serviceBlock(name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `service ${name} exists`);
  const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}
/** `KEY: value` pairs of a service's `environment:` map (6-space indent). */
function environment(service: string): Record<string, string> {
  const block = serviceBlock(service).split("\n");
  const start = block.findIndex((l) => l === "    environment:");
  assert.ok(start >= 0, `${service} has environment`);
  const out: Record<string, string> = {};
  for (const l of block.slice(start + 1)) {
    if (!/^ {6}/.test(l)) break;
    const m = /^ {6}([A-Z0-9_]+): (.*)$/.exec(l);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}
/** Compose-style interpolation: ${V}, ${V:-default}, ${V:?message}. */
function interpolate(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::([-?])([^}]*))?\}/g, (_m, name, op, arg) => {
    const v = vars[name];
    if (v) return v;
    if (op === "-") return arg;
    if (op === "?") throw new Error(`required: ${name}`);
    return "";
  });
}

/** Every list item under every `ports:` key (any service), comments removed. */
function publishedPorts(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)ports:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (m[2] && !m[2].startsWith("#")) out.push(m[2]); // inline [..] form: always flagged
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^\s*(#.*)?$/.test(l)) continue;
      const indent = /^(\s*)/.exec(l)![1]!.length;
      if (indent <= m[1]!.length) break;
      const item = /^\s+-\s*(.*?)\s*(#.*)?$/.exec(l);
      if (item) out.push(item[1]!);
      else out.push(l.trim()); // a nested key of a long-syntax item
    }
  }
  return out;
}
/** Items that are not `"${VAR:-127.0.0.1}:…"`. */
function unsafePorts(text: string): string[] {
  return publishedPorts(text).filter((p) => !/^"\$\{[A-Z0-9_]+:-127\.0\.0\.1\}:[^"]+"$/.test(p));
}

const SECRET_VARS = [
  "LIVEKIT_API_SECRET",
  "REDIS_PASSWORD",
  "VOICE_AGENT_HMAC_SECRET",
  "SARVAM_API_KEY",
];
const SERVICES = ["redis", "livekit", "sip", "voice-agent"];

describe("local stack: images", () => {
  test("every pulled image is pinned by tag AND digest", () => {
    const images = [...compose.matchAll(/^ {4}image: (.+)$/gm)].map((m) => m[1]!);
    const pulled = images.filter((i) => i !== "clickai-voice-agent:local");
    assert.equal(pulled.length, 3);
    for (const i of pulled) assert.match(i, /:[\w.-]+@sha256:[0-9a-f]{64}$/, i);
  });
  test("the expected versions: server v1.13.11, SIP v1.23.0, Redis 7.4.7", () => {
    assert.match(compose, /livekit\/livekit-server:v1\.13\.11@sha256:/);
    assert.match(compose, /livekit\/sip:v1\.23\.0@sha256:/);
    assert.match(compose, /library\/redis:7\.4\.7-alpine@sha256:/);
  });
});

describe("local stack: networking", () => {
  test("Redis publishes no port and sits only on the internal network", () => {
    const redis = serviceBlock("redis");
    assert.doesNotMatch(redis, /^\s+ports:/m);
    assert.match(redis, /networks: \[backend\]/);
    assert.match(compose, /^ {2}backend:\n {4}internal: true$/m);
  });
  test("EVERY published port binds to 127.0.0.1 unless explicitly overridden", () => {
    const items = publishedPorts(compose);
    assert.equal(items.length, 7, items.join(" | "));
    assert.deepEqual(unsafePorts(compose), []);
    // The guard itself: each unsafe form is caught.
    const mutants = [
      '"7880:7880"',
      "7880:7880",
      '"0.0.0.0:7880:7880"',
      '"${LOCAL_BIND_IP:-0.0.0.0}:7880:7880"',
      '"${LOCAL_BIND_IP}:7880:7880"',
      '"${LOCAL_BIND_IP:-127.0.0.1}:7880:7880"\n      - "5061:5061/udp"',
    ];
    for (const m of mutants) {
      const mutated = compose.replace('"${LOCAL_BIND_IP:-127.0.0.1}:7880:7880"', m);
      assert.notEqual(mutated, compose);
      assert.ok(unsafePorts(mutated).length > 0, `not caught: ${m}`);
    }
    // Long syntax is refused outright (it could bind anywhere).
    assert.ok(
      unsafePorts(compose.replace(/^ {4}ports:\n/m, "    ports:\n      - target: 1\n")).length > 0,
    );
  });
  test("SIP RTP range and LiveKit UDP range match their published ranges", () => {
    const sip = serviceBlock("sip");
    const [, a, b] = /rtp_port: (\d+)-(\d+)/.exec(sip)!;
    assert.match(sip, new RegExp(`:${a}-${b}:${a}-${b}/udp`));
    const lk = serviceBlock("livekit");
    const s = /port_range_start: (\d+)/.exec(lk)![1];
    const e = /port_range_end: (\d+)/.exec(lk)![1];
    assert.match(lk, new RegExp(`:${s}-${e}:${s}-${e}/udp`));
  });
});

describe("local stack: secrets", () => {
  test("no credential has a literal value in the compose file", () => {
    for (const v of [...SECRET_VARS, "LIVEKIT_API_KEY"]) {
      for (const m of compose.matchAll(new RegExp(`${v}: (.+)$`, "gm")))
        assert.match(m[1]!, /^"?\$\{/, `${v} must come from the env file`);
    }
    for (const m of compose.matchAll(/^\s+(?:password|api_key|api_secret): (.+)$/gm))
      assert.match(m[1]!, /^\$\{/, m[0]);
    assert.match(
      compose,
      /LIVEKIT_KEYS: "\$\{LIVEKIT_API_KEY:\?[^}]*\}: \$\{LIVEKIT_API_SECRET:\?[^}]*\}"/,
    );
  });
  test("webhooks are signed with the configured key", () => {
    assert.match(serviceBlock("livekit"), /webhook:\n\s+api_key: \$\{LIVEKIT_API_KEY\}/);
  });
  test(".env.example carries names only, and documents every variable the compose file reads", () => {
    for (const line of envExample.split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)))
      assert.match(line, /^[A-Z0-9_]+=$/, `no value in .env.example: ${line}`);
    const documented = new Set([...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]!));
    const code = compose.replace(/^\s*#.*$/gm, "").replace(/ #.*$/gm, "");
    const used = new Set([...code.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]!));
    for (const v of used) assert.ok(documented.has(v), `${v} documented in .env.example`);
  });
  test("init-env.sh never overwrites, writes mode 600 and prints no value", () => {
    assert.match(initEnv, /if \[ -e "\$target" \]; then[\s\S]*?exit 1/);
    assert.match(initEnv, /umask 077/);
    assert.match(initEnv, /chmod 600 "\$target"/);
    assert.match(initEnv, /\} > "\$target"/);
    assert.ok(statSync(join(root, "deploy/local/init-env.sh")).isFile());
  });
});

describe("local stack: services", () => {
  test("every service has a health check and a restart policy", () => {
    for (const s of SERVICES) {
      const b = serviceBlock(s);
      assert.match(b, /^\s+healthcheck:/m, `${s} healthcheck`);
      assert.match(b, /^\s+restart: \*restart$/m, `${s} restart`);
    }
    assert.match(compose, /^x-restart: &restart unless-stopped$/m);
  });
  test("SIP and the agent wait for a healthy LiveKit (and SIP for Redis)", () => {
    assert.match(serviceBlock("sip"), /livekit: \{ condition: service_healthy \}/);
    assert.match(serviceBlock("sip"), /redis: \{ condition: service_healthy \}/);
    assert.match(serviceBlock("voice-agent"), /livekit: \{ condition: service_healthy \}/);
  });
});

describe("local stack: the agent is Sarvam-only", () => {
  const env = environment("voice-agent");
  test("LLM_PROVIDER is fixed to sarvam; no env_file, no Anthropic or fallback variable", () => {
    assert.equal(env["LLM_PROVIDER"], "sarvam");
    assert.equal(env["SARVAM_LLM_BASE_URL"], "https://api.sarvam.ai/v1");
    assert.doesNotMatch(serviceBlock("voice-agent"), /^\s+env_file:/m);
    for (const k of Object.keys(env))
      assert.doesNotMatch(k, /ANTHROPIC|CLAUDE|FALLBACK_LLM|SIP_OUTBOUND/);
  });
  test("the agent's compose environment passes config validation and builds the Sarvam LLM only", () => {
    const vars = {
      LIVEKIT_API_KEY: "APIlocaltest",
      LIVEKIT_API_SECRET: "s".repeat(64),
      VOICE_AGENT_HMAC_SECRET: "h".repeat(64),
      SARVAM_API_KEY: "test-key",
    };
    const resolved = Object.fromEntries(
      Object.entries(env).map(([k, v]) => [k, interpolate(v, vars)]),
    );
    const c = loadConfig(resolved);
    assert.equal(c.LLM_PROVIDER, "sarvam");
    assert.equal(c.ANTHROPIC_API_KEY, undefined);
    const l = buildLlm(c);
    assert.ok(!(l instanceof llm.FallbackAdapter), "no fallback adapter");
    assert.equal(l.label(), "openai.LLM", "Sarvam via the OpenAI-compatible adapter");
    assert.throws(
      () => loadConfig({ ...resolved, FALLBACK_LLM_BASE_URL: "https://fallback.example/v1" }),
      /FALLBACK_LLM_BASE_URL must not be set/,
    );
  });
  test("LIVEKIT_ALLOWED_HOSTS is passed through for self-hosted hosts", () => {
    assert.equal(env["LIVEKIT_ALLOWED_HOSTS"], "${LIVEKIT_ALLOWED_HOSTS:-}");
    const base = {
      APP_ENV: "staging",
      LIVEKIT_URL: "wss://livekit.example.in",
      LIVEKIT_API_KEY: "k",
      LIVEKIT_API_SECRET: "s".repeat(32),
      SARVAM_API_KEY: "x",
      KLYRO_BASE_URL: "https://klyro.example",
      VOICE_AGENT_HMAC_SECRET: "h".repeat(32),
      LLM_PROVIDER: "sarvam",
    };
    assert.throws(() => loadConfig(base), /LIVEKIT_ALLOWED_HOSTS/);
    assert.doesNotThrow(() => loadConfig({ ...base, LIVEKIT_ALLOWED_HOSTS: "livekit.example.in" }));
  });
});

describe("Dockerfile turn-detector switch", () => {
  test("production defaults are unchanged: model downloaded and verified", () => {
    assert.match(dockerfile, /^ARG DOWNLOAD_TURN_DETECTOR=1$/m);
    assert.match(dockerfile, /^ARG VERIFY_TURN_DETECTOR=1$/m);
    assert.match(
      dockerfile,
      /if \[ "\$DOWNLOAD_TURN_DETECTOR" = "1" \]; then\s+\\\n\s+npx livekit-agents download-files/,
    );
  });
});

describe("sipApiUrl (provision:sip against a local server)", () => {
  test("TLS for every host; plain HTTP only for loopback", () => {
    assert.equal(sipApiUrl("wss://livekit.example.in"), "https://livekit.example.in");
    assert.equal(sipApiUrl("https://x.livekit.cloud"), "https://x.livekit.cloud");
    assert.equal(sipApiUrl("ws://127.0.0.1:7880"), "http://127.0.0.1:7880");
    assert.equal(sipApiUrl("ws://localhost:7880"), "http://localhost:7880");
    assert.throws(() => sipApiUrl("ws://livekit.example.in"), ProvisionError);
    assert.throws(() => sipApiUrl("http://10.0.0.5:7880"), ProvisionError);
    assert.throws(() => sipApiUrl("not a url"), ProvisionError);
  });
});
