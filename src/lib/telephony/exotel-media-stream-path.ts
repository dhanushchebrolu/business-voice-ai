/**
 * The single, canonical path Exotel's Voicebot Applet must connect its
 * WebSocket to. Shared by every consumer that needs to recognize or route
 * this path — src/server.ts's top-level fetch handler (routes the upgrade
 * to the CallSessionDurableObject when the CALL_SESSION binding exists, or
 * to exotel-media-route.server.ts's local-dev fallback otherwise),
 * exotel-media-route.server.ts, and call-session-durable-object.server.ts.
 *
 * Previously this string was duplicated as a private local constant in all
 * three files independently — correct today, but a silent drift risk: a
 * future edit to one copy without the other two would make the WebSocket
 * upgrade route mismatch the path Exotel's dashboard is actually configured
 * to hit, and nothing would fail loudly (the request would just 404, or
 * never reach the intended handler). A single exported constant makes that
 * class of bug structurally impossible.
 *
 * This is a PATH, not a full URL — the full WSS URL Exotel's dashboard call
 * flow must be configured with is `wss://<deployed-worker-host>` + this
 * path, e.g. `wss://klyro.aiblaze-io.workers.dev/api/public/media-stream/exotel`
 * for the production deployment. See PHASE_D1_EXOTEL_FINAL_REPORT.md §20 for
 * the full required Exotel dashboard configuration (this is a Voicebot
 * Applet flow node's WSS URL, a distinct, separate flow step from the
 * account's HTTP status-callback URL — configuring only the latter means
 * Exotel never opens this WebSocket at all).
 */
export const EXOTEL_MEDIA_STREAM_PATH = "/api/public/media-stream/exotel";
