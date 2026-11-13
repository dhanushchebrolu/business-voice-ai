# Sarvam draft 5 vs production v4: eval results (13 Nov 2026)

Agent `Conversatio-9c6a04cd-3334`, suite `01M22ETHF4SMEDY6F089GSGM43`, the 10 "ClickAI:" scenarios.
Both versions use the same identity variable mapping. Production stays on v4; draft 5 is not committed.

## Results

| Scenario | v4 | draft 5 | Notes |
|---|---|---|---|
| All details in the first sentence | 4/4 | 4/4 | Both check availability once, ask only for the name, never re-ask |
| Caller corrects the date | 3/3 | 3/3 | Both switch to Sunday at once; v5 had a stray word ("turn 3:00 PM") |
| Opening hours and location | 3/3 | 3/3 | 08:00–20:00, Kukatpally |
| Insurance and EMI | 2/2 | 2/2 | No yes or no; team confirms |
| Reschedule | 2/2 | 2/2 | No pretend reschedule, no callback time |
| Dental emergency | 3/3 | 3/3 | No transfer claim; clinic number and 108 |
| Repeated question | 2/2 | 2/2 | Consistent services; root canal ₹5,000 from facts |
| Unclear request | 2/2 | 2/2 | |
| Unrelated request | 1/1 | 1/1 | |
| Reminder request | 1/1 | 1/1 | No SMS promise |

- **Behaviour checked:**
  - Repeated questions: none in either version.
  - Corrections: accepted in both versions.
  - Hallucinated facts: none.
  - Tool failures: none. Every `check_availability` returned real slots.
- **Small differences:**
  - In the date-correction close, v4 said the team would call "soon" (a mild time promise). Draft 5 did not.
  - Draft 5 once inserted a stray word ("turn") before a slot time.

## Isolation (production ClickAI, read-only query)

- Eval calls identify the caller as `evals@sarvam.ai`, an email, so ClickAI treats each one as a test caller.
- Since 12:25 UTC: 0 new bookings and 0 new leads.
- All 4 `book_appointment` events and all 20 `call_outcome` events are flagged `test_call=true`.
- After a refused booking, the agent says the team will call back, and Sarvam classifies the call as `callback_requested`. For a real caller, that creates a ClickAI lead, so the callback promise is backed by a lead.

## Not covered by these runs

- **Text simulation only:** the agent answered English and Hinglish callers in Telugu, because language detection works from speech.
  - Language switching, interruptions, silence nudges (draft 5: 20 s plus 20 s, then hang up) and latency need real calls to the number.
  - Earlier phone test: short English and Hindi phrases (1.2–1.7 s) were detected as Telugu.
- One run per scenario, so LLM variance is not measured.

## To go live with v5 (needs explicit approval)

1. Commit draft 5 in Sarvam.
2. Set the ClickAI mapping to 5.
3. Run "Sync to mapped version". It pauses the deployment, edits it and resumes it, so live calls are briefly paused.

## Rollback

- Set the ClickAI mapping back to 4, then run "Sync to mapped version". v4 stays committed and unchanged.
- Emergency: pause deployment `Smile-Denta-be071be0-703e` in Sarvam. Calls then stop being answered.
