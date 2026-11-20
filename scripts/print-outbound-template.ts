/**
 * Prints the OUTBOUND agent template exactly as ClickAI's code generates it
 * (sarvamToolConfiguration(base, "outbound") + the allowed/forbidden tool
 * lists), so the operator copies what the backend enforces instead of a
 * hand-written copy. Read-only: no network, no database.
 *
 *   node --experimental-strip-types scripts/print-outbound-template.ts https://clickai.in
 */
import { sarvamToolConfiguration } from "../src/lib/sarvam-agent-api.server.ts";
import {
  OUTBOUND_AGENT_TOOLS,
  OUTBOUND_FORBIDDEN_TOOLS,
  roleAllowsAgentApi,
} from "../src/lib/agent-roles.ts";
import { AGENT_TOOLS } from "../src/lib/sarvam-agent-api.server.ts";
import { OUTBOUND_AGENT_TEMPLATE_VERSION } from "../src/lib/universal-agent-config.ts";

const base = process.argv[2] ?? "https://clickai.in";
const template = sarvamToolConfiguration(base, "outbound");
console.log(
  JSON.stringify(
    {
      templateVersion: OUTBOUND_AGENT_TEMPLATE_VERSION,
      allowedTools: OUTBOUND_AGENT_TOOLS,
      forbiddenTools: OUTBOUND_FORBIDDEN_TOOLS,
      backendGate: Object.fromEntries(
        [undefined, ...AGENT_TOOLS].map((t) => [t ?? "context", roleAllowsAgentApi("outbound", t)]),
      ),
      template,
    },
    null,
    2,
  ),
);
