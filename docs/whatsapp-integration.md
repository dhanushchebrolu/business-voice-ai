# WhatsApp integration

WhatsApp runs through **Vobiz**, ClickAI's WhatsApp BSP (Meta-approved Business
Solution Provider): Vobiz holds every number's Meta credentials, and ClickAI
talks only to Vobiz's API (`https://api.vobiz.ai/api/v1/messaging`, the same
`VOBIZ_AUTH_ID`/`VOBIZ_AUTH_TOKEN` account as voice). The earlier direct-Meta
integration (ClickAI's own Meta app exchanging codes, registering numbers,
subscribing webhooks and sending through the Graph API) has been removed.
Connections live in `whatsapp_connections`
(`20260923090000_whatsapp_business_integration.sql`, plus the Vobiz columns of
`20261027090000_whatsapp_vobiz_channels.sql`), next to the existing voice
agents, bookings and Razorpay payment flow. The features:

- **Connecting a number.** Three ways, below.
- **Webhooks.** Authenticated, idempotent, with monotonic delivery statuses.
- **AI replies.** From the business's own agent, with human handoff.
- **Bookings and payments in chat.** Bookings, reschedules and payment holds from a WhatsApp chat: the AI proposes, the customer confirms with YES, and the server acts.
- **Notifications.** Booking confirmation, reschedule, cancellation, 24-hour reminder, payment link, and payment captured / failed / expired.
- **Consent.** A consent ledger (STOP/START, staff-attested opt-ins, Meta's opt-out signal) and a suppression list.
- **Templates and campaigns.** A Message Template registry synced from Meta, and consent-only marketing campaigns with rate limits, scheduling, delivery analytics and an audit log.
- **Dashboard.** All of it on `/app/whatsapp`.

## Connecting a number (three options)

All three run server-side (`whatsapp-onboarding.functions.ts` →
`whatsapp-vobiz-onboarding.server.ts`), only for an owner or admin of the
chosen business's organization, behind the existing WhatsApp feature gate.
Each ends in a Vobiz channel recorded as a `whatsapp_connections` row
(`provider = 'vobiz'`, `vobiz_channel_id`, `number_onboarding_mode`). A number
live for another organization is refused before Vobiz is called; a repeat
request for an already connected number returns it without calling Vobiz
again; a channel Vobiz created during a request whose response was lost is
found with `GET /channels/whatsapp` and adopted **only** if it carries every
identifier the request expects (the same WABA id, and the same Meta phone
number id — or, for a ClickAI number, the same Vobiz number order) and no
other organization has ever used it in ClickAI. A number match alone is never
enough; a mismatch, a missing identifier or two candidates stops recovery
with `recovery_refused` ("contact ClickAI support") for an administrator to
resolve. Disconnecting never deletes the Vobiz channel.

1. **Bring your own number** (`bring_your_own`): the eligibility rules are
   shown first (the number needs a WABA in Meta Business Manager, one provider
   only, and can't stay registered in the WhatsApp / WhatsApp Business app —
   ClickAI never unregisters anything). ClickAI asks Vobiz to send a code by
   SMS or voice call (`POST /numbers/whatsapp/bring-your-own/verify`, at most
   5 counted requests per organization per hour, claimed atomically in
   `whatsapp_byon_verifications`); the business enters it with its WABA ID,
   phone number ID and Meta system-user token (`.../confirm`, then
   `POST /channels/whatsapp` with `number_provider: "meta_direct"`). The
   token goes to Vobiz in that one request; ClickAI never stores or logs it.
   Vobiz documents no delivery confirmation for these codes, so the UI says at
   most "Verification request accepted. Delivery has not been confirmed."
2. **A number from ClickAI** (`buy_from_vobiz`): customers can't buy
   numbers. A platform admin (`numbers.write`) buys one on ClickAI's Vobiz
   account for a client from **Admin → Phone numbers → Buy WhatsApp number**
   (`GET /numbers/whatsapp/availability`, confirm,
   `POST /numbers/whatsapp/orders`). A `whatsapp_number_orders` row (no
   organization: a platform record) is written **before** Vobiz is asked to
   buy and is unique per number platform-wide while live, so a double click,
   retry or second admin never buys twice; an unknown outcome is marked
   `unknown` and never retried. An accepted order and the client's
   `phone_numbers` row (`provisioning`, `whatsapp_capable`, not
   `voice_capable`) are recorded in one transaction
   (`record_whatsapp_number_purchase`); if that fails the lock stays and both
   ids are logged (`whatsapp_number_order:unrecorded`) for reconciliation.
   The admin activates the number with the existing **Activate** action; the
   client's owner/admin then connects it on the WhatsApp page with their WABA
   ID (`POST /channels/whatsapp` with `number_order_id`). A client without
   one can ask for a number (a `whatsapp_number_requested` customer event).
   A number connected to WhatsApp can't be reassigned or released until it
   is disconnected, and a channel that belongs to another WABA or another
   organization is never adopted. Not verified against Vobiz: whether a
   channel from a reassigned number must be deleted at Vobiz before the new
   client can link the order (Vobiz then refuses, and the client sees "not
   ready"); this needs Vobiz's confirmation before any number is reassigned.
3. **Embedded Signup through Vobiz** (`embedded_signup`): Meta's own popup runs
   in the browser with the Meta app and Embedded Signup configuration that
   Vobiz exchanges codes for (`VITE_VOBIZ_WHATSAPP_ES_*`); the resulting code,
   WABA ID and phone number ID go to `POST /channels/whatsapp/embedded-signup`.
   Closing the popup is not an error. Without the three build variables only
   this option is unavailable.

**Disconnect** stops ClickAI using the number (row kept, `status =
'disconnected'`; the Vobiz channel is not deleted). **Reconnect** restores it
if the channel still exists at Vobiz and the number isn't live elsewhere.

## Sources of truth (nothing is duplicated)

| Concern                                       | Source of truth                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Bookings, availability, overlap               | `bookings` and the atomic RPCs (`create_booking_atomic`, `create_booking_payment_hold`, `reschedule_booking_atomic`) |
| AI agent (prompt, knowledge, tool permission) | `agent_configs` via `generateSharedAgentReply` and `ai-tools.server.ts` (the same as voice and Instagram)            |
| Payment state                                 | `payment_requests.status`, changed **only** by the verified Razorpay webhook (`payment-webhook.server.ts`)           |
| Payment links                                 | `createPaymentRequestForBooking` → Razorpay Payment Links API (existing)                                             |
| Who was notified                              | `whatsapp_notifications` (outbox) + `whatsapp_messages`                                                              |
| May we message this number?                   | `whatsapp_consent_events` (latest event per business, number and scope) + `whatsapp_suppressions`                    |

## Inbound messages and AI replies

1. Vobiz POSTs to `/api/public/webhooks/whatsapp` (ClickAI's one account-level subscription, `POST /api/v1/messaging/webhooks`). Events: `message.inbound`, `message.status` (sent/delivered/read/failed); `call.*` is acknowledged and ignored.
2. **Signature.** `X-Webhook-Signature` must be the hex HMAC-SHA256 of the raw body with `VOBIZ_WHATSAPP_WEBHOOK_SECRET` (no prefix), or the route answers `401` before reading anything (`whatsapp-webhook-handler.server.ts`).
3. **Store** (`whatsapp-inbound.server.ts`):
   - Vobiz's `event_id` is claimed in `webhook_events` (`provider = 'vobiz_whatsapp'`, the whole envelope kept as `payload`); its `payload` field is the WhatsApp Cloud API change value;
   - messages are unique per `(connection, wa_message_id)`;
   - statuses only move forward, within the connection the payload names;
   - the tenant comes only from `metadata.phone_number_id`; a `channel_id`, if present, must name the same connection (else the event is retained, `routing_conflict`);
   - an event that can't be applied yet — no live connection for its number (e.g. it arrived before onboarding saved the connection), or a status for a message whose wamid isn't recorded yet — is **deferred**, never marked processed: replayed by the dispatch cron (and by Vobiz's redelivery) with backoff (1 min … 6 h), at most 8 attempts, then retained (`gave_up:*`);
   - an event that must not be applied automatically (no `phone_number_id`, routing conflict) is **retained** for an operator; a signed body without the documented envelope (e.g. no `event_id`) is kept under `provider = 'vobiz_whatsapp_unrecognized'`, keyed by the SHA-256 of its bytes — never a made-up event id — and never applied;
   - if storage fails, the event stays due and the route answers `500`, so Vobiz retries (bounded).
4. Meta's error `131050` ("user stopped marketing messages") on a delivery status is recorded as a marketing opt-out.
5. Vobiz gets its `200` at once. Replies run in the background (`whatsapp-ai-reply.server.ts`), one per inbound message (a claimed row, unique `reply_to_message_id`):
   1. **STOP / START.** STOP is recorded as an opt-out for both scopes; START only opts back in to booking and payment messages (marketing needs its own explicit opt-in). Recorded even when AI is off, no agent is assigned, the number isn't connected or the 24-hour window has closed; acknowledged only when the number is connected and the window is open.
   2. **Guards.** AI is on for the conversation, an agent from the same organization is assigned, the message is inside the 24-hour window, and the conversation has had at most 5 AI replies in 10 minutes. A message skipped because AI was off, no agent was assigned or the rate limit was hit is marked (`metadata.ai_reply_skipped`) and never answered later, by the recovery sweep or a retry. A message whose own reply is already claimed is never marked: the claim is answered once, or taken over if its worker crashed.
   3. **YES / NO.** A clear YES or NO to an open proposal is handled by the server (`whatsapp-actions.server.ts`, below).
   4. **Handoff.** A customer asking for a person turns AI off and closes any open proposal.
   5. **Reply.** Otherwise the shared agent replies: last 20 messages, 25 s timeout, one retry.
6. **Recovery.** `POST /api/public/cron/whatsapp-replies` retries replies that were interrupted.

### Bookings, reschedules and payments from a chat

On WhatsApp the model can't call `book_appointment`, `reschedule_appointment`, `create_payment_required_booking`, `request_payment` or `check_payment_status`. It gets three channel tools instead:

- **`list_my_bookings`:** the sender's own upcoming bookings (identity = the WhatsApp number Meta verified).
- **`propose_booking`:**
  - checks the agent's capability, the times, and the service (organization- and business-scoped);
  - stores **one** pending action;
  - a priced service, for an agent allowed to take payments, becomes a payment hold at the **service's** price, never a model-chosen amount.
- **`propose_reschedule`:** only for a booking that the sender's number owns (`callerOwnsBooking`, the voice rule).

The customer's next clear **YES** — only if the reply that showed them the proposal was actually sent (`sent`, `delivered` or `read`):

- claims the action once;
- runs it through the existing tool layer (`executeAiTool`), so capability checks and the database's atomic availability re-check still apply;
- sets the booking phone to the verified sender;
- for a reschedule, passes exactly the confirmed move through `guardBookingOwnership`.

The reply is composed by the server from the real result. **NO** declines, anything else leaves the proposal open, and proposals expire after 15 minutes. A proposal whose reply never reached the customer (the AI failed, timed out or returned nothing, or the send failed or is unconfirmed) is closed instead, and a timed-out AI attempt can't store one late. Cancellations aren't automated on WhatsApp: the AI hands them to staff.

## Notifications (outbox)

Database triggers add one row per logical notification to `whatsapp_notifications`, keyed by a unique `dedupe_key`. They fire on `bookings` (insert, status and start-time changes), on `payment_requests` (link created) and on `payment_domain_events` (verified webhook outcomes). So every writer is covered: voice tools, the dashboard, the atomic RPCs and the payment webhook. **Nothing is enqueued for a business that hasn't turned notifications on.**

| Kind                                                                                     | When                                                                                                                                                    | Template purpose (body params)                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `booking_confirmed`                                                                      | a booking is created active (CONFIRMED / RESCHEDULED / CALENDAR_SYNC_FAILED), or moves to active from DRAFT / PENDING_CONFIRMATION                      | `booking_confirmed` (3: first name, business, date-time)          |
| `booking_rescheduled`                                                                    | an active booking's start time changes (one per move, including a move back to an earlier time; only the newest notice naming the current time is sent) | `booking_rescheduled` (3)                                         |
| `booking_cancelled`                                                                      | an active or held booking is cancelled                                                                                                                  | `booking_cancelled` (3)                                           |
| `booking_reminder`                                                                       | ~24 h before (enqueued by the cron sweep; one per start time)                                                                                           | `booking_reminder` (3)                                            |
| `payment_link`                                                                           | a payment request with a link is created (recovery for `request_payment`'s inline send)                                                                 | `payment_link` (1: the full message incl. link)                   |
| `payment_captured`, `payment_captured_after_expiry`, `payment_failed`, `payment_expired` | a verified-webhook domain event (recovery for the webhook's inline consumer)                                                                            | `payment_confirmation` / `payment_failed` / `payment_expired` (1) |

A hold confirmed by payment (PENDING_PAYMENT → CONFIRMED) gets the payment confirmation only, never a second "booking confirmed".

The worker (`whatsapp-notifications.server.ts`, run by the dispatch cron):

- **Claims** a row with conditional updates: pending, or a `sending` claim abandoned for 5 minutes. Two workers never send the same row.
- **Re-reads current state** before sending. A confirmation for a booking cancelled since, a superseded reschedule or reminder, or a link for a paid/closed request is `skipped` with a reason.
- **Sends** through `sendBusinessWhatsAppMessage` (`whatsapp-business-message.server.ts`), the one path for every business-initiated message. In order, and nothing is written or sent until all pass:
  1. **Purpose and scope agree:** marketing only with the marketing consent scope; booking/payment only with the transactional scope.
  2. **The business's own connected number:** organization + business, and the exact connection when the caller pins one (campaigns). If a business has several connected numbers, one is chosen deterministically: for booking/payment messages only numbers with notifications on (if any), then the number the customer already talks to, otherwise the earliest connected.
  3. **A unique live idempotency key**, checked across all of the business's connected numbers, so the inline sender and the worker can't both deliver.
  4. **Recipient consent and suppression** (below).
  5. **Business notification settings, re-read at send time:**
     - Booking notifications always need notifications on and a recorded consent basis (20+ characters).
     - So do payment messages outside the 24-hour window.
     - A payment message inside an open window answers a conversation the customer started, so it doesn't need the switch; it still needs consent and suppression checks.
  6. **Templates:** free text only inside the window. Otherwise, and always for marketing, only a template from **this number's synced registry** that is APPROVED, of the right category (UTILITY for booking/payment, MARKETING for campaigns), with positional parameters matching the message.
     - A `WHATSAPP_TEMPLATE_*_NAME` variable can only _select_ a registry row; it never proves approval.
     - A campaign's template is re-verified by id on the campaign's own number.
     - Anything unverifiable fails with a reason code (`template_missing`, `template_not_found_for_number`, `template_not_approved`, `template_wrong_category`, `template_named_params`, `template_param_mismatch`).
  7. **Bounded delivery retries.**

  Database errors in any of these checks throw (fail closed): nothing is sent.

- **Retries** with exponential backoff, up to 5 attempts, only when safe (Vobiz answered 429, or a transient DB error). A rejection is never repeated. A **5xx is not retried**: a gateway can fail after Vobiz accepted the message, and Vobiz documents no idempotency key.
- **Unknown outcomes** (a timeout after the request left, a 5xx, or a 2xx without a message id): the message row **stays `queued`**, with "Delivery outcome unknown" in `error_message` and `metadata.delivery_outcome = "unknown"` (plus the error kind and HTTP status). It therefore keeps blocking every later attempt with the same idempotency key (inline sender, outbox, campaign), so it is never sent twice. It needs a person to check. A staff reply in this state is shown as "Delivery unknown" (not "Not sent"), and sending the same draft again reuses its request id, so it can't go out twice. A campaign recipient stuck this way is marked failed ("Delivery unknown") after its attempts run out, so the campaign can complete.
- **Skips stale rows:** anything older than 48 h is skipped, never sent late.

Payment truth is never touched: the worker only reads `payment_requests` and `bookings`. Payment messages are re-checked against the current state before sending: "payment didn't go through, try again" only while the request is still payable (`CREATED`/`PENDING`), and no "booking confirmed" for a booking cancelled meanwhile. A WhatsApp failure never undoes a capture. The webhook's inline consumer now records `whatsapp_error` (instead of a misleading `whatsapp_dispatched_at`) and the outbox retries.

## Consent, suppression and campaigns

- **Transactional** (booking/payment):
  - An owner/admin turns notifications on per number and must record the basis on which customers agree (`transactional_consent_basis`, audited). The sender re-checks both at send time.
  - This business declaration is in addition to the recipient's own state, never a substitute: an explicit opt-out (STOP) or a suppression always wins.
  - Transactional messages don't need a per-recipient opt-in event; the recorded basis covers that. Requiring one would block voice-booking confirmations until opt-ins are captured.
- **Which event counts:**
  - The latest event per business, number and scope wins. On an exact timestamp tie, an **opt-out** wins.
  - Except: a customer's own opt-out (STOP, their own form) or Meta's "stopped marketing" signal stands until the **customer** opts in again (START, their own form). A staff-attested or imported opt-in never reverses it, and the dashboard refuses to record one. A staff-recorded opt-out can still be corrected by staff.
  - Customer keywords and Meta's signal are ordered by **when they happened** (the message's or status's own timestamp, never later than processing time), not when they were processed, so a START processed late can't overtake a later STOP.
  - **Staff and system messages into a conversation** are refused while such a customer or Meta opt-out stands (in either scope), even inside the 24-hour window, until the customer writes again (a message after the opt-out; the STOP itself doesn't count) or opts back in. The STOP acknowledgement itself is still sent.
  - Every consent row is read, paged in a stable order, so a large history (or PostgREST's max-rows) can't hide an older opt-out.
- **Marketing:**
  - Only to numbers whose **latest marketing consent is an explicit opt-in** (a staff-attested opt-in with evidence, or an import; a customer's START does not count) and that aren't suppressed.
  - Checked at launch **and again right before each message**.
- **Campaigns** (`whatsapp-campaigns.server.ts`):
  - APPROVED **MARKETING** templates only.
  - Parameters come from fixed text, the contact's first name, or the business name.
  - Audience is "everyone opted in" or a contact list, which is filtered the same way. Ineligible numbers are recorded as `skipped` with the reason.
  - Rate: `max_per_minute` (≤ 80) and a send window (`schedule`, with a valid IANA time zone; an existing campaign with an invalid one is auto-paused with the reason).
  - Pause and cancel take effect within a running batch: the campaign is re-read before every send, so at most the message already in flight goes out.
  - Dispatch is fair: each cron tick takes the least recently dispatched running campaigns, at most 5 per organization and 20 in total, so one tenant's campaigns (or ones waiting for their window) can't block others. A campaign with nothing left completes even while its window is closed.
  - Resumable and idempotent per `(campaign, number)`.
  - Auto-paused if the template stops being APPROVED or most of a batch fails.
  - Analytics combine recipient outcomes with Meta's delivery/read statuses.
- **Audit log** (`whatsapp_audit_log`): notification settings, template mapping, consent changes (staff and customer), suppressions, campaign create / launch / pause / resume / cancel / auto-pause.

## Dashboard (`/app/whatsapp`)

- **Connection:** the three connection options, assign a bot, disconnect, reconnect (owner/admin only; `whatsapp-access.server.ts`).
- **Conversations:** the inbox, AI switch and staff replies.
- **Booking & payment notifications:** on/off per number with the consent basis (owner/admin), plus recent notification outcomes.
- **Message templates:**
  - sync through Vobiz (`POST /channels/{id}/templates/sync`, then `GET /channels/{id}/templates`; owner/admin/manager). A list Vobiz returns in an unexpected shape changes nothing;
  - map an APPROVED **UTILITY** template to each notification purpose (owner/admin; parameter count checked).
- **Customer consent:** record a staff-attested opt-in/opt-out with evidence (any role but viewer).
- **Campaigns:** create a draft, launch, pause, resume and cancel (owner/admin/manager), with analytics.
- **Audit log.**

All server functions (`whatsapp-messaging.functions.ts`, `whatsapp-conversations.functions.ts`) take the organization from the signed-in user's membership. Reads go through RLS. Writes use the service role, filtered by that organization. No token is ever selected.

## Razorpay: payment links and QR

- **Payment Links** (`POST /v1/payment_links` through the merchant's OAuth connection) are what's implemented and used. Razorpay's hosted link page offers the merchant's enabled methods, including UPI.
- **Dedicated UPI QR codes** (Razorpay's QR Codes API) are **not implemented**. That API needs the merchant to have QR Codes enabled, and the existing integration doesn't create QR codes, so nothing here claims to.
- **Merchant configuration required:**
  - a CONNECTED `razorpay_connections` row per business (dashboard OAuth);
  - Payment Links enabled on the merchant account;
  - a webhook in the Razorpay dashboard to `https://<host>/api/public/webhooks/razorpay-payments`, with the secret in `RAZORPAY_CUSTOMER_PAYMENTS_WEBHOOK_SECRET`, subscribed to the payment-link events (`payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`) and `payment.failed`.
- The webhook's event field names were written defensively and **must be verified against Razorpay's live documentation** (see `payment-webhook.server.ts`).

## Required configuration

Server-side (Cloudflare Worker secrets; names already in `.env.example` unless marked new):

| Variable                                                                                                                      | Purpose                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` (optional `VOBIZ_BASE_URL`)                                                               | ClickAI's Vobiz account (shared with voice): onboarding, sending, templates.                                                                                                                        |
| `VOBIZ_WHATSAPP_WEBHOOK_SECRET` (new)                                                                                         | Secret of the Vobiz webhook subscription; verifies `X-Webhook-Signature`. Without it every delivery is refused.                                                                                     |
| `ANTHROPIC_API_KEY` (optional `CLAUDE_MODEL`)                                                                                 | AI replies.                                                                                                                                                                                         |
| `LOVABLE_CRON_SECRET`                                                                                                         | Bearer secret for the cron routes.                                                                                                                                                                  |
| `RAZORPAY_CUSTOMER_PAYMENTS_WEBHOOK_SECRET`, `RAZORPAY_*` OAuth / credential key                                              | Existing Razorpay customer payments.                                                                                                                                                                |
| `WHATSAPP_TEMPLATE_PAYMENT_*_NAME` / `_LANGUAGE`                                                                              | Optional: **selects** a synced registry template by name + language (default `en_US`) when none is mapped to the purpose. The template must still be in this number's registry as APPROVED UTILITY. |
| `WHATSAPP_TEMPLATE_BOOKING_{CONFIRMED,RESCHEDULED,CANCELLED,REMINDER}_NAME` / `_LANGUAGE`                                     | Optional, same rule. Prefer mapping synced templates in the dashboard (per number; Tech Provider customers each have their own WABA).                                                               |
| `VITE_VOBIZ_WHATSAPP_ES_APP_ID`, `VITE_VOBIZ_WHATSAPP_ES_CONFIG_ID`, `VITE_VOBIZ_WHATSAPP_ES_GRAPH_VERSION` (new, build-time) | Embedded Signup popup: the Meta app/config Vobiz exchanges codes for (values from Vobiz). Optional: only that option needs them.                                                                    |

No longer used by WhatsApp: `META_WHATSAPP_CONFIG_ID`, `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `VITE_META_*`. `META_APP_ID`, `META_APP_SECRET` and `META_GRAPH_API_VERSION` stay: Instagram uses them.

**"WhatsApp is not configured on this deployment yet."** A connection step shows this when `VOBIZ_AUTH_ID` or `VOBIZ_AUTH_TOKEN` is missing on the Worker; the Worker log `whatsapp_onboarding:not_configured` lists the missing names (never values). Missing `VITE_VOBIZ_WHATSAPP_ES_*` only disables Embedded Signup (the build log line `[build-env-diagnostic] WhatsApp Embedded Signup (Vobiz) build vars:` names them).

**One-time Vobiz setup:** see "Production setup: Vobiz webhook" below. Ask Vobiz for the Embedded Signup Meta app/config ids if that option is wanted.

**Cron** (external scheduler, `POST` with `Authorization: Bearer $LOVABLE_CRON_SECRET`):

- `/api/public/cron/whatsapp-dispatch` **every minute**: proposals expiry, reminders, notifications, campaigns.
- `/api/public/cron/whatsapp-replies` every 2–5 minutes.
- The existing `/api/public/cron/expire-payments`.

**Meta templates to create and get approved per WABA (UTILITY):**

- three-parameter booking templates, e.g. `Hi {{1}}, your appointment at {{2}} is confirmed for {{3}}.`;
- one-parameter payment templates;
- MARKETING templates for campaigns.

Templates with named parameters aren't supported.

## Database migrations

Eight new files, all additive and idempotent: `20261013090000` (server-role grants on the integration tables), `20261019090000`, `20261020090000`, `20261022090000`, `20261026090000` (owner/admin-only bot assignment), `20261027090000` (Vobiz channels and number orders), `20261028090000` (ClickAI numbers in the phone-number inventory) and `20261029090000` (Vobiz reliability). This work did not apply any of them anywhere, and production state is unverified: no production database access was used.

### `20261029090000_whatsapp_vobiz_reliability.sql`

- **Adds:**
  - table `whatsapp_byon_verifications` (one row per BYON code request: Vobiz's verification id, status and expiry — never the code or a token; RLS on, server role only) and `claim_whatsapp_byon_verification()` (the per-organization hourly limit, serialized with an advisory lock so concurrent requests can't bypass it; server role only);
  - `webhook_events.attempts` (default 0) / `next_attempt_at`, plus a partial index for due retries — the deferred / retained states above; other providers' rows are untouched;
  - `whatsapp_messages.provider_message_id` (Vobiz's message id from the send response), unique per connection; backfilled from `metadata.vobiz_message_id` where unambiguous.
- **Impact:** one new table and function, defaulted/nullable columns (no rewrite), one bounded backfill `UPDATE` of `whatsapp_messages`, new indexes. Works with the code before and after this change.
- **Order:** after `20260923090000`; does **not** need `20261028090000` (tested on a database without it). **Apply before deploying the code that uses it** (the BYON request calls the function).
- **Rollback:** SQL in the migration's header (code first; `metadata.vobiz_message_id` is still written).
- **Test:** `supabase/migrations/whatsapp_vobiz_reliability.pg.test.ts`.

### `20261028090000_whatsapp_clickai_number_inventory.sql`

- **Adds:**
  - `phone_numbers.voice_capable` (default true) / `whatsapp_capable` (default false), at least one true; every existing number becomes voice-only, and voice code only considers `voice_capable` rows;
  - one live `whatsapp_number_orders` row per number platform-wide; nullable `organization_id`; `phone_number_inventory_id`;
  - `whatsapp_connections.inventory_number_id`, one live connection per inventory number;
  - ownership triggers on both tables (advisory-locked per number): no live connection for a number another organization holds or that is unassigned; no inventory assignment of a number another organization has live on WhatsApp; no reassignment/release while connected;
  - `record_whatsapp_number_purchase()` (service role only).
- **Impact:** defaulted columns (no rewrite); index builds on `phone_numbers` and `whatsapp_connections` (both small). The triggers refuse a write that would put one number in two organizations — including, for voice, adding a number another organization has connected to WhatsApp.
- **Pre-check (read-only):** `SELECT p.e164, p.organization_id, c.organization_id FROM phone_numbers p JOIN whatsapp_connections c ON regexp_replace(c.display_phone_number,'[^0-9]','','g') = regexp_replace(p.e164,'[^0-9]','','g') WHERE c.status <> 'disconnected' AND p.status NOT IN ('released','failed') AND p.organization_id IS DISTINCT FROM c.organization_id;` — expected empty; existing conflicting pairs aren't rejected by the migration, but reassigning or reconnecting those rows is then refused.

### `20261019090000_whatsapp_ai_replies.sql`

- **Adds:**
  - `whatsapp_conversations.ai_enabled` / `handoff_requested_at` / `last_inbound_at`;
  - `whatsapp_messages.reply_to_message_id` (unique partial index) / `attempts`;
  - an index on `whatsapp_messages (connection, status)`;
  - a trigger keeping a connection's agent in its own organization.
- **Impact:** new defaulted columns (no rewrite on PostgreSQL 11+); two index builds on `whatsapp_messages` (short write lock).
- **Pre-check:**
  ```sql
  SELECT c.id FROM whatsapp_connections c JOIN agent_configs a ON a.id = c.agent_config_id
  WHERE a.organization_id <> c.organization_id;           -- expect 0 rows
  ```
- **Rollback:**
  ```sql
  DROP TRIGGER IF EXISTS trg_whatsapp_connection_agent_same_org ON whatsapp_connections;
  DROP FUNCTION IF EXISTS whatsapp_connection_agent_same_org();
  DROP INDEX IF EXISTS idx_whatsapp_messages_one_reply_per_inbound, idx_whatsapp_messages_connection_status;
  ALTER TABLE whatsapp_messages DROP COLUMN IF EXISTS reply_to_message_id, DROP COLUMN IF EXISTS attempts;
  ALTER TABLE whatsapp_conversations DROP COLUMN IF EXISTS ai_enabled,
    DROP COLUMN IF EXISTS handoff_requested_at, DROP COLUMN IF EXISTS last_inbound_at;
  ```
  The code must be rolled back first, since it reads these columns.

### `20261020090000_whatsapp_notifications_and_campaigns.sql`

- **Adds:**
  - `whatsapp_connections.notifications_enabled` (default **false**), `transactional_consent_basis`, `notifications_enabled_at` / `_by`;
  - tables `whatsapp_consent_events` (append-only), `whatsapp_suppressions`, `whatsapp_templates`, `whatsapp_notifications`, `whatsapp_pending_actions`, `whatsapp_campaigns`, `whatsapp_campaign_recipients`, `whatsapp_audit_log` (RLS: members read their own organization; only the service role writes);
  - triggers on `bookings`, `payment_requests` and `payment_domain_events`;
  - the unique index `idx_whatsapp_messages_idempotency_live`.
- **Impact:**
  - Booking/payment writes run one extra trigger that does nothing unless the business enabled notifications. None has, so applying it sends nothing.
  - The unique index build briefly locks `whatsapp_messages` writes.
- **Pre-check** (expect 0 rows; otherwise the unique index fails and the migration aborts cleanly):
  ```sql
  SELECT whatsapp_connection_id, metadata->>'idempotency_key', count(*)
  FROM whatsapp_messages
  WHERE metadata ? 'idempotency_key' AND status IN ('queued','sent','delivered','read')
  GROUP BY 1, 2 HAVING count(*) > 1;
  ```
- **Immediate stop without a deploy:** `UPDATE whatsapp_connections SET notifications_enabled = false;` and pause campaigns.
- **Rollback (destructive for the new tables):**
  1. Export `whatsapp_consent_events` and `whatsapp_audit_log` first (consent evidence).
  2. Run:
     ```sql
     DROP TRIGGER IF EXISTS trg_whatsapp_booking_notifications ON bookings;
     DROP TRIGGER IF EXISTS trg_whatsapp_payment_link_notifications ON payment_requests;
     DROP TRIGGER IF EXISTS trg_whatsapp_payment_event_notifications ON payment_domain_events;
     -- Tables before functions: whatsapp_campaigns' trigger depends on whatsapp_campaign_same_tenant().
     DROP TABLE IF EXISTS whatsapp_campaign_recipients, whatsapp_campaigns, whatsapp_pending_actions,
       whatsapp_notifications, whatsapp_templates, whatsapp_suppressions, whatsapp_consent_events, whatsapp_audit_log;
     DROP FUNCTION IF EXISTS whatsapp_booking_notification_trigger(), whatsapp_payment_link_notification_trigger(),
       whatsapp_payment_event_notification_trigger(), whatsapp_campaign_same_tenant(),
       enqueue_whatsapp_notification(uuid, uuid, uuid, uuid, text, text, jsonb, interval),
       whatsapp_notifications_enabled_for(uuid);
     DROP INDEX IF EXISTS idx_whatsapp_messages_idempotency_live;
     ALTER TABLE whatsapp_connections DROP COLUMN IF EXISTS notifications_enabled,
       DROP COLUMN IF EXISTS transactional_consent_basis, DROP COLUMN IF EXISTS notifications_enabled_at,
       DROP COLUMN IF EXISTS notifications_enabled_by;
     ```
     Run it in one transaction (`psql --single-transaction`): an error then changes nothing. Verified on a disposable replay of production's 47 migrations: after this rollback the schema matches the 47-migration baseline except for the 20261013 grants.

### `20261022090000_whatsapp_reschedule_notification_key.sql`

- **Changes:** redefines `whatsapp_booking_notification_trigger()` (`CREATE OR REPLACE`; the trigger stays bound) so the reschedule dedupe key names the move and its transaction (`booking_rescheduled:<booking>:<old start>:<new start>:<txid>`). A booking moved A → B → C → B now gets a notice for the last move. Nothing else in the function changes.
- **Impact:** none on existing rows (their keys stay as they are); no locks beyond replacing a function.
- **Order:** after `20261020090000`. Safe whether or not `20261020090000` has already been applied somewhere.
- **Rollback:** re-run the function definition from `20261020090000`. The worker's newest-only rule works with either key format.

### `20261026090000_whatsapp_connection_manager_policy.sql`

- **Changes:** the RLS policy that lets browsers update `whatsapp_connections.agent_config_id` now requires an owner/admin of the connection's organization (`has_org_role`), instead of any member. The column grant and every other policy are unchanged.
- **Why:** a staff member or read-only viewer could otherwise change which bot answers customers by calling PostgREST directly, bypassing the dashboard's server function (which now also requires owner/admin: `whatsapp-access.server.ts`).
- **Impact:** replaces one policy (brief lock on `whatsapp_connections`). Works with the code before and after this change.
- **Order:** independent of the other WhatsApp migrations; needs only `20260923090000`. Test: `supabase/migrations/whatsapp_connection_manager_policy.pg.test.ts`.
- **Rollback:** recreate the previous policy (`USING/WITH CHECK (public.is_org_member(organization_id))`); the exact SQL is in the migration's header.

### `20261027090000_whatsapp_vobiz_channels.sql`

- **Adds:** `whatsapp_connections.provider` (`meta_direct` default for existing rows, or `vobiz`), `vobiz_channel_id` (required for `vobiz`; unique among non-disconnected rows), `number_onboarding_mode`, `vobiz_number_order_id`; table `whatsapp_number_orders` (RLS: members read their own organization; only the service role writes; one live order per organization and number). Browsers can read `provider` and `number_onboarding_mode`, not the channel id.
- **Impact:** defaulted/nullable columns (no rewrite), one partial unique index, a new table. Works with the code before and after this change.
- **Order:** after `20260923090000`; independent of the others. **Must be applied before the Vobiz code is deployed** (the code writes these columns).
- **Rollback:** SQL in the migration's header (drops the new table — export it first — and the columns).
- **Test:** `supabase/migrations/whatsapp_vobiz_channels.pg.test.ts`.

**Approval gate:** apply only after explicit approval. Order:

1. Back up.
2. Apply to a non-production branch/project and run the pre-checks and tests there.
3. Apply to production in order (20261013, 20261019, 20261020, 20261022, 20261026, 20261027, then 20261029; 20261028 only together with the code that needs it).
4. Deploy the code.
5. Turn on notifications for one business.

## Data retention

- **No automatic deletion** is implemented: deleting data is a business/legal decision.
- **Keep the consent ledger** (`whatsapp_consent_events`) and audit log as evidence. They're append-only for the server, and rows go away only with their organization/business (cascade).
- **Candidates for a scheduled purge**, once a retention period is chosen:
  - `whatsapp_notifications` in a final state (`sent` / `skipped` / `failed`);
  - `whatsapp_pending_actions` that aren't `awaiting_confirmation`;
  - completed campaigns' recipient rows.

## Tests

```bash
node --test src/lib/whatsapp/*.test.ts src/lib/payments/*.test.ts \
  src/lib/whatsapp-*.test.ts src/lib/shared-agent-reply.server.test.ts \
  src/components/app/WhatsAppConnectOptions.test.ts src/routes/app.whatsapp.test.ts \
  src/routes/api/public/webhooks/whatsapp.test.ts src/routes/api/public/cron/whatsapp-*.test.ts
# Real PostgreSQL (skips without one); POSTGREST_BIN=/path/to/postgrest also runs
# the worker, reminders and a campaign through supabase-js against a real PostgREST.
node --test supabase/migrations/whatsapp_*.pg.test.ts
```

The in-memory database used by the library tests (`src/lib/whatsapp/whatsapp-test-db.ts`) mirrors the real unique constraints. Vobiz itself is always a mocked stand-in in these tests (request/response shapes from Vobiz's documentation); no test calls the real Vobiz API. The PostgreSQL suites prove the real behaviour (triggers, RLS, grants, PostgREST filters).

## Diagnosing onboarding and webhooks

- **BYON states** (`whatsapp_byon_verifications.state`): `requested` (claimed, Vobiz not answered), `pending` (Vobiz answered 2xx with its id and status `pending` — accepted, **not** delivered), `unrecognized` (2xx ClickAI couldn't interpret: empty/malformed body, no usable id, no status, a status other than `pending`, a bad `expires_at` — outcome unknown, no meaning inferred), `unavailable` (timeout / network / 429 / 5xx — outcome unknown, still counted), `rejected` (4xx — no code sent, not counted), `confirmed` (the code was confirmed). A code is refused before Vobiz is asked when the latest `pending` request's `expires_at` has passed. The `whatsapp_byon_otp_requested` timeline event is written for `pending` and `unrecognized` answers only. Delivery is never confirmed by ClickAI. A number is verified only when `connectByon` succeeds, and connected only when a `whatsapp_connections` row with `status = 'connected'` exists.
- **Log lines** (no secrets, codes or message content):
  - `whatsapp:schema_mismatch` — a WhatsApp action hit a missing column/table (e.g. 42703 before `20261027090000`); the customer sees "a database update is pending".
  - `whatsapp_byon:verify_response_unrecognized` — a 2xx verify answer ClickAI couldn't interpret (`reason`, a validated `status`, key names; no values).
  - `whatsapp_byon:verify_outcome_unknown` — timeout / network / 429 / 5xx on a verify request (error kind and HTTP status only).
  - `whatsapp_onboarding:recovery_refused`, `whatsapp_onboarding:channel_identity_mismatch`, `whatsapp_onboarding:channel_owned_elsewhere` — channel recovery stopped for an administrator (counts or Vobiz channel id only).
  - `whatsapp_webhook:envelope_unrecognized` (key names), `whatsapp_webhook:payload_without_phone_number_id`, `whatsapp_webhook:routing_conflict` — retained events; `whatsapp_webhook:no_live_connection`, `whatsapp_webhook:status_unmatched` — deferred events; `whatsapp_webhook:retries_exhausted`, `whatsapp_webhook:replay_failed`.
  - Find them: `SELECT event_id, event_type, attempts, error, next_attempt_at FROM webhook_events WHERE provider LIKE 'vobiz_whatsapp%' AND processed_at IS NULL ORDER BY created_at DESC;`
- **Routing.** A delivery is matched only by `payload.metadata.phone_number_id` (Vobiz's Events Reference: the payload is a slice of the Cloud API change value). Vobiz's Quick Start example shows a different, flat shape (top-level `channel_id`, flat `message`, no `event_id`); it is not confirmed, so such a delivery is kept as unrecognized, not applied. Which shape Vobiz actually sends is unconfirmed: check `webhook_events.payload` after the first real delivery.
- **Delivery statuses** are matched by the wamid in `statuses[].id` (Vobiz's documented correlation). Vobiz's own message id is stored (`whatsapp_messages.provider_message_id`) but is never used as a wamid; Vobiz documents no other identifier in `message.status`. A message whose send returned `meta_message_id: null` therefore can't be matched: its statuses are deferred, retried, then retained (`gave_up:status_unmatched`) and the message stays `sent`. Resolving that needs Vobiz to confirm which identifier a status carries or how to look up the wamid.
- **Numbers in the WhatsApp / WhatsApp Business app** can't be connected with BYON until that account is deleted (Vobiz: one provider per number, not on the consumer apps). Coexistence (keeping the app) is not documented by Vobiz and is not supported here.

## Production setup: Vobiz webhook

What ClickAI implements (`src/routes/api/public/webhooks/whatsapp.ts` → `whatsapp-webhook-handler.server.ts`):

| Item      | Value                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| URL       | `https://app.clickai.in/api/public/webhooks/whatsapp` (POST only; no GET handshake)                                                             |
| Events    | `message.inbound`, `message.status`; `call.*` is acknowledged and ignored                                                                       |
| Signature | `X-Webhook-Signature` = hex HMAC-SHA256 of the raw body with the subscription secret, no prefix                                                 |
| Secret    | Worker secret `VOBIZ_WHATSAPP_WEBHOOK_SECRET`; missing → every delivery is answered `401`                                                       |
| Body      | Vobiz envelope `event_id`, `event_type`, `account_id`, `occurred_at`, `payload` (payload = WhatsApp Cloud API change value)                     |
| Responses | `200` with the outcome (processed/duplicate/ignored/deferred/retained/unrecognized), `401` bad signature, `500` storage failure (Vobiz retries) |

Vobiz's documentation (vobiz-mcp-server `skills/vobiz-whatsapp/SKILL.md`) says only: subscriptions are managed at `POST|GET /webhooks` and `DELETE /webhooks/{id}` under `https://api.vobiz.ai/api/v1/messaging`, deliveries are signed with the subscription `secret`, and the secret is never returned after creation. It does **not** document the request fields (URL, event selection), who generates the secret, or whether one subscription covers every channel on the account. Create the subscription in the Vobiz Console's Webhooks page (or confirm the API fields with Vobiz first), and:

1. Only after the new code is deployed and its migrations (through `20261029090000`) are applied: today's production route is the retired Meta webhook and rejects Vobiz deliveries.
2. Set `VOBIZ_WHATSAPP_WEBHOOK_SECRET` to the subscription's secret before (or together with) creating the subscription; copy it at creation, Vobiz won't show it again.
3. Subscribe `message.inbound` and `message.status`.
4. Check: an unsigned POST to the URL returns `401`; a real inbound message appears in the WhatsApp inbox.

A channel created in the Vobiz Console (outside ClickAI) has no `whatsapp_connections` row, so its messages are ignored until it is connected to a workspace from ClickAI.

## Production setup: migration reconciliation

Production (2026-10-27): of `20261024`–`20261028`, only `20261025090000_whatsapp_vobiz_onboarding` is applied. That file is not in this repository; its contents were never reviewed here. Read-only steps before applying anything:

```sql
-- 1. Full applied history (expect 47 known versions plus 20261025090000):
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;
-- 2. Exactly what 20261025 executed (the CLI stores the statements):
SELECT statements FROM supabase_migrations.schema_migrations WHERE version = '20261025090000';
-- 3. Objects 20261027/20261028 create that may already exist from 20261025:
SELECT table_name, column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'whatsapp_connections' AND column_name IN
         ('provider','vobiz_channel_id','number_onboarding_mode','vobiz_number_order_id','inventory_number_id'))
     OR (table_name = 'phone_numbers' AND column_name IN ('voice_capable','whatsapp_capable'))
     OR table_name = 'whatsapp_number_orders');
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid IN ('public.whatsapp_connections'::regclass, 'public.phone_numbers'::regclass)
   AND conname LIKE ANY (ARRAY['whatsapp_connections_%','phone_numbers_%']);
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND tablename IN ('whatsapp_connections','phone_numbers','whatsapp_number_orders');
SELECT p.proname, pg_get_function_identity_arguments(p.oid) FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN
   ('phone_number_key','enforce_whatsapp_connection_number_owner','enforce_phone_number_whatsapp_owner','record_whatsapp_number_purchase');
-- 4. The Vobiz channel already in production, if 20261025 stored it:
SELECT id, organization_id, status, phone_number_id, display_phone_number FROM public.whatsapp_connections;
```

Then: add the exact `20261025090000` file (copied from the machine that applied it, not rewritten) to `supabase/migrations/` so the replay tests cover it and `supabase db push` stops reporting a remote-only version, and re-review `20261027`/`20261028` against it — their `IF NOT EXISTS` / `duplicate_object` guards would silently keep a same-named object from `20261025` even if its definition differs.
