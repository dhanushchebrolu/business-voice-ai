/**
 * Compatibility stub. This class coordinated calls for a telephony provider ClickAI no longer
 * supports. Nothing sends it requests.
 *
 * It stays because Cloudflare binds it by name (binding CALL_SESSION, migration
 * v1-call-session in wrangler.json). Removing a Durable Object class needs a delete migration,
 * which destroys the class's objects and blocks rolling the Worker back to any earlier version.
 * Do not remove or rename it without that decision. It holds no storage.
 */
export class CallSessionDurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Gone", { status: 410 });
  }
}
