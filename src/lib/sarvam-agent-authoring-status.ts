/**
 * What stands between ClickAI and unattended Sarvam agent creation, in one
 * place (shown on the admin Provisioning page, repeated in
 * docs/sarvam-unattended-agent-authoring-request.md). Checked against the
 * official docs 2026-11-27.
 */

export interface AuthoringStatus {
  /** true only when a real machine credential and provider implementation are wired in. */
  unattended: boolean;
  mode: "operator_bridge" | "unattended";
  blocker: string;
  needsFromSarvam: string[];
}

export const AUTHORING_STATUS: AuthoringStatus = {
  unattended: false,
  mode: "operator_bridge",
  blocker:
    "Sarvam documents agent create/clone/configure/commit only in its MCP server, which signs in through interactive SSO (24 h token, no refresh token) and has no service-account or client-credentials route. The public REST API key does not reach agent authoring.",
  needsFromSarvam: [
    "A workspace-scoped service credential (or client-credentials grant) for the Voice Agents MCP server / an agent-authoring REST API",
    "Permissions: create agent, clone agent, configure agent (prompt, tools, voice, languages), commit version, read agent; no org-admin rights",
    "Long-lived or refreshable (documented renewal), revocable, usable server-side from a Cloudflare Worker",
    "Confirmation the credential keeps working on our single workspace (customers stay inside ClickAI's workspace, no per-customer Sarvam accounts)",
  ],
};
