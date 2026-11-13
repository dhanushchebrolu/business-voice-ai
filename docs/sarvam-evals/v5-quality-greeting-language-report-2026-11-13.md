# ClickAI × Sarvam: conversation quality, languages and custom greeting (13 Nov 2026)

**Status:**
- **Production:** unchanged. Live deployment `Smile-Denta-be071be0-703e` still runs Sarvam v4, and the ClickAI mapping is still 4.
- **Sarvam:** draft 5 is edited but not committed.
- **ClickAI:** code changes are local, not deployed. No database migration.

## 1. What went wrong in the voice test (trace `20261113/63d1cf6b-18:17:36`)

| Turn | Caller audio | Sarvam speech-to-text result | Layer at fault |
|---|---|---|---|
| 3 | English, 1.7 s | Tagged te-IN (0.99): "ఐ వాంట్ టు బుక్ అన్ అపాయింట్మెంట్" (English written in Telugu script) | Speech-to-text and language detection |
| 4 | English, 4.2 s | en-US: correct, and the reply was in English | Works |
| 5 | Hindi, 3.8 s | hi-IN: correct, and the reply was in Hindi | Works |
| 8 | Telugu, 1.9 s | te-IN: correct | Works |
| 9 | Hindi, 1.7 s | Tagged te-IN; text came out in **Gujarati script** ("ઠીક હૈ પાંચ બજે બુક કર દો") | Speech-to-text and language detection (this was the "Gujarati" sentence) |
| 10 | English, 1.3 s | Tagged te-IN, Telugu script | Speech-to-text and language detection |
| 11 | Hindi, 1.8 s | Tagged te-IN | Speech-to-text and language detection |

**Conclusion:** language switching does work on utterances of about 2 s or more. On short phrases (≤1.8 s), Sarvam's language detection keeps the previous language with near-certain confidence, and the reply follows that tag.

The prompt cannot fix this:
- Sarvam's validator rejects prompt rules that steer the reply language.
- Speech recognition is already at Sarvam's strongest settings: `saarika-v4`, `lid_mode: always`, a 1 s minimum.
- The only other values (0, 3 or 5 s) can't help, because detection already ran on these utterances and got them wrong.

This needs a Sarvam support case (draft below).

Other defects in the same call:
- **"4 PM is not available" was false:** the tool had returned 16:00 as free. The agent decided availability itself.
- **"General checkup" was accepted:** Smile Dental doesn't offer it. The tool and the agent took any service name.
- **Phone and booking consent were conflated:** "Yes, use this number" was treated as consent to book.
- **"I have saved your request" was false:** nothing had been saved.

## 2. Changes

### ClickAI code (not deployed)

| File | Change |
|---|---|
| `src/lib/agent-greeting.ts` (new) | `renderGreeting`: the tenant's custom greeting, used verbatim with `{business_name}` / `{agent_name}` filled in, or the automatic "Welcome to <business>. How can I help you today?" |
| `src/lib/agent-greeting.test.ts` (new) | Tests for automatic and custom greetings, placeholders and tenant separation |
| `src/lib/sarvam-agent-api.server.ts` | See the list below this table. |
| `src/lib/sarvam-agent-api.server.test.ts` | 10 new tests (39 in total) |
| `src/routes/app.agent.tsx` | Dashboard "Greeting & first impression" section (see the list below). |
| `src/lib/agent-instructions.ts` | An empty greeting no longer marks the agent incomplete (empty means automatic) |
| `src/lib/voice-agent/voice-agent-api.test.ts` | Expectation updated for the rule above |

Changes in `src/lib/sarvam-agent-api.server.ts`:
- **Greeting:** the call context now includes a `greeting` variable.
- **`matchService`:** maps a requested service to one configured service and never substitutes another. It returns `SERVICE_NOT_OFFERED`, `SERVICE_AMBIGUOUS` or `SERVICE_REQUIRED`, and passes the service ID to the booking.
- **`check_availability`:** accepts the caller's `time`, and the server answers `IS FREE` or `IS NOT FREE` plus the nearest three times.
- **New `request_callback` tool:** saves the lead during the call, and the agent may promise a callback only after `recorded: true`. It runs once per call, and the end-of-call record skips its own lead when this one exists. Test callers get the recorded path without a lead.
- **End of call:** the record now stores `facts` taken from ClickAI's own tool log: availability, booking outcome, booking ID, service ID, callback and lead ID.
- **Live v4 is unaffected:** service validation runs only when the agent sends `require_service`, which only the draft 5 tools do.

Dashboard changes in `src/routes/app.agent.tsx`:
- an on/off switch (off = automatic greeting);
- a greeting text box (300 characters);
- a greeting language selector;
- a live preview;
- saving through the existing Save button.

### Sarvam draft 5 (not committed)

- **Intro:** `{{greeting}}` in every language slot, so it is never translated. The Telugu "I'm Aarti, the clinic's virtual assistant" intro is gone.
- **Starting language:** English instead of Telugu. Supported languages are unchanged (Te/En/Hi) and language detection stays on.
- **Prompt edits (10):**
  - no self-introduction;
  - no booking push after enquiries;
  - keep "today by 8 PM" style context;
  - configured services only, translated from any language;
  - the server decides whether a time is free;
  - the booking question is separate from the phone-number notice;
  - honest booking states (CONFIRMED / SAVED / PENDING / NOT BOOKED);
  - callbacks only after `request_callback` replies RECORDED;
  - explain a limitation only once.
- **Tools:**
  - `check_availability` and `book_appointment` send `require_service` (plus `time` for `check_availability`) and have new reply templates;
  - new `request_callback` tool;
  - `clickai_business_context` saves `greeting`;
  - `record_call_outcome` sends `requested_slot`.
  - All of these use credential `CLICKAI_API_KEY`, re-selected in the console because Sarvam's MCP can't attach secrets.
- **Variables:** `greeting` and `requested_slot`, and a factual `call_summary` instruction.

### How the greeting gets to Sarvam, and tenant isolation

1. **Storage:** the greeting is stored in `agent_configs.greetings`, keyed by language. This column already existed, so there is no migration. It is saved through `saveAgentConfiguration`, which first checks `requireBusinessAccess`.
2. **At call start:** Sarvam's on-start tool calls `/api/public/sarvam/agent/context` with the tenant's own bearer token. That token resolves the integration, then the organization, then that organization's agent. A request body can never choose the tenant.
3. **Delivery:** ClickAI returns `greeting`, Sarvam saves it into the `greeting` variable, and the intro speaks `{{greeting}}`.

One shared Sarvam app serves every tenant, with no per-customer app. A test confirms two tenants each receive only their own greeting.

## 3. Eval results (draft 5, text simulations)

All 26 ClickAI scenarios ran on draft 5. 14 of the 16 new ones also ran on v4 before Sarvam credits ran out (402 Quota Exceeded).

| Scenario | v4 | Draft 5 |
|---|---|---|
| Unsupported service ("general checkup") | **Fail** (checked and booked it) | Pass (refused; named the real services) |
| Greeting has no self-introduction | **Fail** ("I'm Aarti… virtual assistant") | No self-introduction ✔; business name missing ✖ (see the limitation below) |
| Booking intent with date and latest time ("today by 8 PM") | Pass | Pass |
| Requested time not free | Pass | Pass |
| Time correction / phone agreement is not booking consent | Pass | Pass |
| Failed booking and callback wording | not run (credits) | 2/3: no false success; on a callback-tool failure it didn't give the clinic number |
| Hindi service name (Devanagari) | Pass | Pass (switched to Hindi via `change_output_language`) |
| Telugu service name / Telugu-English mix / English to Telugu switch / Hinglish | 2/2, 2/2, 2/2, 1/2 | Understood correctly, **but replied in English** |
| Gujarati caller | 0/2 (replied in Telugu) | 1/2 (said it speaks only En/Hi/Te) |
| Earlier 10 ClickAI scenarios | 10/10 | 9/10 (emergency: it gave the number and 108 but didn't say "I can't transfer") |

**Reading the language rows:**
- Text simulations have no speech, so no language detection runs. Draft 5 answers in its starting language (now English) unless the model calls `change_output_language`.
- On a real call, language detection switches the reply (shown in the trace above), except on short phrases.

**Isolation (production read-only query, since 13:10 UTC):**
- 0 new bookings and 0 new leads;
- 20 `book_appointment` and 38 `call_outcome` events, every one flagged `test_call=true`.
- Eval callers are `evals@sarvam.ai`, which ClickAI treats as a test caller.

## 4. Remaining limitations

1. **Short-phrase language detection (Sarvam platform):** phrases of 1.8 s or less are tagged with the previous language. Needs Sarvam support or model improvement; the prompt can't steer it.
2. **Starting language is set per Sarvam app, not per call:**
   - A tenant's greeting is spoken with the app's starting language voice (now English).
   - A Telugu-text greeting on an English-start app may be read with English pronunciation.
   - Per-tenant greeting language needs per-language apps or a Sarvam feature.
3. **Gujarati and other languages:** the app supports only Telugu, English and Hindi. Adding Gujarati is one config change, but more languages make short-phrase mis-tagging likelier. Test it in a separate draft.
4. **Greeting before the ClickAI deploy:** the live endpoint doesn't return `greeting`, so draft 5 says the default "Hello. How can I help you today?" (never empty). The tenant greeting needs the new code deployed.
5. **`request_callback` before the ClickAI deploy:** it gets a 404, so the agent says the request couldn't be saved. After the deploy, real failures give the clinic number through the reply template.
6. **Data issue:**
   - Smile Dental's service is stored as **"Tooth Removel"**. The agent uses it exactly, and callers hear the misspelling. Fix it in the dashboard.
   - "consultation" and "teeth cleaning" are not configured services, so two of the earlier ClickAI scenarios now (correctly) get "not offered".
7. **Vertical wording:** the prompt is shared across tenants but still says "clinic" and has a dental-emergency section. Per-vertical templates are a follow-up.
8. **Voice tests:** the in-app browser pane blocks the microphone. Run Sarvam's **Test agent → Voice** in your own browser.

## 5. Release steps (each needs your approval)

1. Deploy the ClickAI Worker:
   ```
   npx wrangler versions upload -c .output/server/wrangler.json
   npx wrangler versions deploy <id>@100% --name klyro --yes
   ```
   It is safe for live v4: new fields are additive and validation only runs for `require_service`.
2. Top up Sarvam credits, then re-run the 26 draft 5 scenarios and the v4 baseline. Expect the greeting to show the business name, and the callback to reach RECORDED (test path).
3. Run voice tests in your own browser using `docs/sarvam-evals/v5-voice-test-script.md`.
4. Commit draft 5 as Sarvam v5.
5. Set the ClickAI mapping to 5.
6. Run "Sync to mapped version" (pause, edit, resume).

**Rollback:**
- Set the ClickAI mapping back to 4 and run "Sync to mapped version". v4 is unchanged.
- To roll back the Worker:
  ```
  npx wrangler versions deploy 30452201-…@100% --name klyro --yes
  ```
  (current live version: code `ca78890`).
- Emergency: pause the deployment in Sarvam.

## 6. Sarvam support request (draft)

> Agent `Conversatio-9c6a04cd-3334` uses `saarika-v4`, `lid_mode: always` and `min_audio_duration_for_language_lid: 1`, with Telugu, English and Hindi supported.
>
> Utterances of 1.0–1.8 s are tagged with the previous language at ≥0.99 confidence, for example interaction `20261113/63d1cf6b-18:17:36-f2c48b32`, turns 3 and 9–11. In turn 9, Hindi speech was transcribed in Gujarati script while tagged `te-IN`.
>
> Is there a setting that improves language detection on short phrases, or a way to prevent transliterating into the previous language's script?
