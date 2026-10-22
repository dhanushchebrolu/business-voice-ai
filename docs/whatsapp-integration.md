# WhatsApp integration

This builds on the existing WhatsApp Business connection (Embedded Signup,
`20260923090000_whatsapp_business_integration.sql`) and the existing voice
agents, bookings and Razorpay payment flow. It adds:

- **Webhooks.** Authenticated, idempotent, with monotonic delivery statuses.
- **AI replies.** From the business's own agent, with human handoff.
- **Bookings and payments in chat.** Bookings, reschedules and payment holds from a WhatsApp chat: the AI proposes, the customer confirms with YES, and the server acts.
- **Notifications.** Booking confirmation, reschedule, cancellation, 24-hour reminder, payment link, and payment captured / failed / expired.
- **Consent.** A consent ledger (STOP/START, staff-attested opt-ins, Meta's opt-out signal) and a suppression list.
- **Templates and campaigns.** A Message Template registry synced from Meta, and consent-only marketing campaigns with rate limits, scheduling, delivery analytics and an audit log.
- **Dashboard.** All of it on `/app/whatsapp`.

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

1. Meta POSTs to `/api/public/webhooks/whatsapp`.
2. **Signature.** `X-Hub-Signature-256` must be the HMAC-SHA256 of the raw body with `META_APP_SECRET`, or the route answers `403` before reading anything.
3. **Store** (`whatsapp-inbound.server.ts`):
   - the body hash is claimed in `webhook_events`;
   - messages are unique per `(connection, wa_message_id)`;
   - statuses only move forward, within the connection the payload names;
   - the tenant comes only from `phone_number_id`;
   - if anything fails, the claim is released and the route answers `500`, so Meta retries.
4. Meta's error `131050` ("user stopped marketing messages") on a delivery status is recorded as a marketing opt-out.
5. Meta gets its `200` at once. Replies run in the background (`whatsapp-ai-reply.server.ts`), one per inbound message (a claimed row, unique `reply_to_message_id`):
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

- **Retries** with exponential backoff, up to 5 attempts, only when safe (Meta answered 429/5xx, or a transient DB error). A rejection is never repeated.
- **Unknown outcomes** (a timeout after the request left, or a 2xx without a message id): the message row **stays `queued`**, with "Delivery outcome unknown" in `error_message`. It therefore keeps blocking every later attempt with the same idempotency key (inline sender, outbox, campaign), so it is never sent twice. It needs a person to check. A staff reply in this state is shown as "Delivery unknown" (not "Not sent"), and sending the same draft again reuses its request id, so it can't go out twice. A campaign recipient stuck this way is marked failed ("Delivery unknown") after its attempts run out, so the campaign can complete.
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

- **Connection:** connect a number, assign a bot.
- **Conversations:** the inbox, AI switch and staff replies.
- **Booking & payment notifications:** on/off per number with the consent basis (owner/admin), plus recent notification outcomes.
- **Message templates:**
  - sync from Meta (owner/admin/manager);
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

| Variable                                                                                  | Purpose                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `META_APP_ID`, `META_APP_SECRET`, `META_WHATSAPP_CONFIG_ID`, `META_GRAPH_API_VERSION`     | Meta app. `META_APP_SECRET` also verifies webhook signatures.                                                                                                                                       |
| `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY`                                                      | AES-256-GCM key for stored WhatsApp tokens (the key they were encrypted with).                                                                                                                      |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN`                                                           | Your random string, also entered in Meta's webhook settings.                                                                                                                                        |
| `ANTHROPIC_API_KEY` (optional `CLAUDE_MODEL`)                                             | AI replies.                                                                                                                                                                                         |
| `LOVABLE_CRON_SECRET`                                                                     | Bearer secret for the cron routes.                                                                                                                                                                  |
| `RAZORPAY_CUSTOMER_PAYMENTS_WEBHOOK_SECRET`, `RAZORPAY_*` OAuth / credential key          | Existing Razorpay customer payments.                                                                                                                                                                |
| `WHATSAPP_TEMPLATE_PAYMENT_*_NAME` / `_LANGUAGE`                                          | Optional: **selects** a synced registry template by name + language (default `en_US`) when none is mapped to the purpose. The template must still be in this number's registry as APPROVED UTILITY. |
| `WHATSAPP_TEMPLATE_BOOKING_{CONFIRMED,RESCHEDULED,CANCELLED,REMINDER}_NAME` / `_LANGUAGE` | Optional, same rule. Prefer mapping synced templates in the dashboard (per number; Tech Provider customers each have their own WABA).                                                               |
| `VITE_META_APP_ID`, `VITE_META_WHATSAPP_CONFIG_ID`, `VITE_META_GRAPH_API_VERSION`         | Browser mirrors for Embedded Signup.                                                                                                                                                                |

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

Four new files on this branch, all additive and idempotent: `20261013090000` (server-role grants on the integration tables), `20261019090000`, `20261020090000` and `20261022090000`. This work did not apply any of them anywhere, and production state is unverified: no production database access was used.

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
     DROP FUNCTION IF EXISTS whatsapp_booking_notification_trigger(), whatsapp_payment_link_notification_trigger(),
       whatsapp_payment_event_notification_trigger(), whatsapp_campaign_same_tenant(),
       enqueue_whatsapp_notification(uuid, uuid, uuid, uuid, text, text, jsonb, interval),
       whatsapp_notifications_enabled_for(uuid);
     DROP TABLE IF EXISTS whatsapp_campaign_recipients, whatsapp_campaigns, whatsapp_pending_actions,
       whatsapp_notifications, whatsapp_templates, whatsapp_suppressions, whatsapp_consent_events, whatsapp_audit_log;
     DROP INDEX IF EXISTS idx_whatsapp_messages_idempotency_live;
     ALTER TABLE whatsapp_connections DROP COLUMN IF EXISTS notifications_enabled,
       DROP COLUMN IF EXISTS transactional_consent_basis, DROP COLUMN IF EXISTS notifications_enabled_at,
       DROP COLUMN IF EXISTS notifications_enabled_by;
     ```

### `20261022090000_whatsapp_reschedule_notification_key.sql`

- **Changes:** redefines `whatsapp_booking_notification_trigger()` (`CREATE OR REPLACE`; the trigger stays bound) so the reschedule dedupe key names the move and its transaction (`booking_rescheduled:<booking>:<old start>:<new start>:<txid>`). A booking moved A → B → C → B now gets a notice for the last move. Nothing else in the function changes.
- **Impact:** none on existing rows (their keys stay as they are); no locks beyond replacing a function.
- **Order:** after `20261020090000`. Safe whether or not `20261020090000` has already been applied somewhere.
- **Rollback:** re-run the function definition from `20261020090000`. The worker's newest-only rule works with either key format.

**Approval gate:** apply only after explicit approval. Order:

1. Back up.
2. Apply to a non-production branch/project and run the pre-checks and tests there.
3. Apply to production in order (20261013, 20261019, 20261020, then 20261022).
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
node --test src/lib/whatsapp/*.test.ts src/lib/payments/*.test.ts src/lib/meta/*.test.ts \
  src/lib/whatsapp-*.test.ts src/lib/shared-agent-reply.server.test.ts \
  src/routes/api/public/webhooks/whatsapp.test.ts src/routes/api/public/cron/whatsapp-*.test.ts
# Real PostgreSQL (skips without one); POSTGREST_BIN=/path/to/postgrest also runs
# the worker, reminders and a campaign through supabase-js against a real PostgREST.
node --test supabase/migrations/whatsapp_*.pg.test.ts
```

The in-memory database used by the library tests (`src/lib/whatsapp/whatsapp-test-db.ts`) mirrors the real unique constraints. The PostgreSQL suites prove the real behaviour (triggers, RLS, grants, PostgREST filters).
