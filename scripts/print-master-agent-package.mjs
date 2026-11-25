// Prints the Sarvam MASTER agent configuration package (what to put on the dedicated, unmapped
// master template in Sarvam). Generated from the same code that builds every customer's work
// order, so the master and the customers never drift. No secrets, no customer data.
//   node --experimental-strip-types scripts/print-master-agent-package.mjs [baseUrl] > master.json
const base = (process.argv[2] ?? "https://clickai.in").replace(/\/+$/, "");
const { sarvamToolConfiguration } = await import("../src/lib/sarvam-agent-api.server.ts");
const { MASTER_AGENT_TOOLS, UNIVERSAL_CAPABILITIES, UNIVERSAL_AGENT_TEMPLATE_VERSION } =
  await import("../src/lib/universal-agent-config.ts");
// Master = every master-agent tool on; each customer's agent turns off what they do not use.
const inbound = sarvamToolConfiguration(base, "inbound", {
  healthcare: false,
  tools: [...MASTER_AGENT_TOOLS],
});
console.log(
  JSON.stringify(
    {
      purpose:
        "ClickAI universal master agent (inbound). Template only: never attach a phone number or deployment.",
      templateVersion: UNIVERSAL_AGENT_TEMPLATE_VERSION,
      baseUrl: base,
      masterTools: MASTER_AGENT_TOOLS,
      capabilities: UNIVERSAL_CAPABILITIES.map((c) => ({
        id: c.id,
        label: c.label,
        tools: c.tools,
      })),
      agent: inbound,
      note: "Tool bearer secret is a per-customer credential issued at provisioning; the master has none.",
    },
    null,
    2,
  ),
);
