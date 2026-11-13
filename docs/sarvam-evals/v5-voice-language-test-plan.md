# Draft 5: languages, short phrases, Gujarati and turn-taking (inspection, config and test plan)

**State:**
- **Production:** unchanged. Live deployment on Sarvam v4; ClickAI Worker `fc0b86da`.
- **Draft 5:** edited, not committed.
- **ClickAI code:** unchanged.
- **Credits:** none spent. The balance is still −25.01.

## 1. What Sarvam actually supports (from the agent schema, workspace limits and docs)

| Area | Setting | Values this workspace allows | v4 | Draft 5 |
|---|---|---|---|---|
| Speech recognition | `asr_model_name` | saarika-v3, saarika-v4 | saarika-v4 | saarika-v4 (newest; kept) |
| Language detection | `lid_mode` | always / once / first_turn | always | always (kept) |
| Minimum audio before a switch ("Switch after") | `min_audio_duration_for_language_lid` | 0, 1, 3, 5 s | 1 | 1 (kept; see 3B) |
| Languages | `supported_languages`, `lid_supported_languages` | any except Sanskrit | Te, En, Hi | **Te, En, Hi, Gujarati** |
| Code-mixed words | `custom_code_mixed_words` | free list | none | **appointment, booking, slot, consultation, check-up, walk-in** |
| Starting language | `initial_language_name` | any | Telugu | English (from the earlier draft 5 change; matches the tenant greeting) |
| Interruptions | `allow_interrupt_during_playback` | true / false | true | true (kept) |
| VAD engine | `primary_vad` | **basic-vad only** (hybrid-vad is not allowed here) | basic | basic |
| Interruption damping and short-reply boost | `probability_modulator_config` | **fixed** (cannot be changed) | default | default |
| End-of-speech silence ("Eagerness") | `silence_duration_frames` | 4, 6, 9, 12 | default 6 | default 6 (kept until there is call evidence) |
| Sound sensitivity | `volume_threshold` | −50 to −20 dBFS | default −35 | default −35 (kept) |
| Response language | prompt | **must not be steered by the prompt** (Sarvam playbook) | none | none |

**Gujarati:**
- It is in the agent's language list.
- The agent's voice (Simran, `sarvam-tts-v3.1-rl-hd`) lists Gujarati.
- Saaras v4 speech recognition covers 22 Indian languages.

So Gujarati is supported by configuration in the managed runtime. Whether calls actually work in spoken Gujarati is **not yet verified**.

## 2. Configuration changed (draft 5 only)

- Added Gujarati to `supported_languages`, `lid_supported_languages` and the LLM's supported languages. Sarvam also added it to its own `change_output_language` tool.
- Added `custom_code_mixed_words`, so business terms stay in English inside Telugu, Hindi and Gujarati sentences.
- Nothing else was changed:
  - prompt, tools and credentials (all six ClickAI tools still use `CLICKAI_API_KEY`);
  - greeting, service validation, callbacks, summaries;
  - v4.

## 3. Status by problem

### A. Te / Hi / En switching: configured; voice behaviour **partially verified**
- Detection is always on, for all three languages, without prompt steering.
- The 13 Nov voice trace showed correct switches on longer phrases (te→en→hi→te) with the context kept.
- **Unverified:** the starting language is now English (it was Telugu in that trace), and code-mixed speech is untested.

### B. Short phrases: **unresolved at the platform level; no further setting can fix it**
- The trace showed phrases of 1.0–1.8 s tagged with the previous language at ≥0.99 confidence, and transcribed in that language's script.
- Every available setting has a cost:

| `min_audio_duration_for_language_lid` | Effect | Cost |
|---|---|---|
| 0 | Detection runs on 1-word replies | More false switches on "ok", "haan", "yes" |
| **1 (kept)** | 1-word replies stay in the current language; clear sentences switch | Short clear switches (about 1–2 s) don't switch |
| 3 or 5 | Even fewer false switches | Clear short sentences never switch; the reply stays in the old language for a full turn |

- Short replies are still understood in context: Saaras writes them out, and the LLM reads "హా / haan / yes" correctly. The text scenarios below check this.
- The remaining gap, a short clear phrase in a new language not switching the reply, is Sarvam's model behaviour. The support request is drafted in `v5-quality-greeting-language-report-2026-11-13.md`.

### C. Gujarati: **enabled in draft 5; spoken audio not verified**
- **Risk:** in the 13 Nov trace, Hindi speech was once transcribed in Gujarati script even with Gujarati disabled. With Gujarati enabled, Hindi callers might be switched to Gujarati.
- This is the first thing the voice tests must check (V7, V8, V2).

### D. Turn-taking: configured with Sarvam's defaults; **not tuned**
- Interruptions are on.
- The interruption damping and the short-reply boost are fixed by the workspace.
- End-of-speech can only be 4, 6, 9 or 12 frames. Without call evidence of cut-ins or long gaps, it stays on the default 6.
- If V9–V11 show the agent cutting callers off, the next step is 9 ("Patient"). If they show long gaps, 4 ("Eager").

### E. Latency: **only past measurements, not verified for draft 5**

Sarvam's `average_agent_response_time` for earlier calls:

| Call | Version | Average agent response |
|---|---|---|
| Real phone, 00:15 IST | v3 | 2.79 s |
| Real phone, 01:09 IST | v4 | 2.29 s |
| Browser tests | v3 and v5 | 1.0–1.76 s |

## 4. Test plan

**Costs, from Sarvam's own usage records:**

| Kind | Cost | Evidence |
|---|---|---|
| Text eval run (`simulated-run`) | ₹2.00 per run | Ledger |
| Draft text chat (`send_chat`) | ₹0 | No usage recorded on 13 Nov |
| Browser Test agent → Voice | ₹0 | About 30 sessions on 12–13 Nov, no usage recorded. **Re-check the balance after the first one.** |
| Real phone call | ₹3.50 per minute (`voice-call-60s-pulses`) + ₹0.20 per 30 s (`vobiz-30s-pulses`) | Ledger |
| Sarvam phone test call to a verified number (outbound) | same call rates | Needs separate approval |

**Mode:** **B** = browser voice test against draft 5, in your own browser (the app's pane blocks the microphone). **T** = text eval.

| # | Scenario | Mode | Expected language | Switch? | Keep context? | Known limits |
|---|---|---|---|---|---|---|
| V1 | Telugu only | B | Telugu throughout | after the English greeting, to Telugu | yes | 1st reply may stay English if the 1st phrase is under ~1.8 s |
| V2 | Hindi only | B | Hindi | to Hindi | yes | watch for Gujarati mis-detection |
| V3 | English only | B | English | none | yes | – |
| V4 | Te → En mid-booking | B | Te then En | yes, after a full sentence | yes | short phrases won't switch |
| V5 | En → Te | B | En then Te | yes | yes | same |
| V6 | Hi ↔ En both ways | B | follows the caller | yes | yes | same |
| V7 | Gujarati only | B | Gujarati | to Gujarati | yes | not verified yet |
| V8 | Gujarati → English | B | Gu then En | yes | yes | not verified yet |
| V9 | Interrupt a long answer ("what services…" then cut in) | B | caller's | – | yes | agent should stop within about 1 s |
| V10 | Short reply after a question (అవును / हाँ / Yes / Okay) | B | stays in the current language | **no** | yes | expected: understood, no switch |
| V11 | Pause 1–2 s mid-sentence, then continue | B | – | – | yes | agent should not cut in; default 6 frames |
| V12 | "చెప్పండి, tomorrow appointment కావాలి" (Te-En mix) | B | Telugu with English terms | stays Telugu | yes | – |
| T1 | Short English yes / no | T | English | no | yes | text run: no detection |
| T2 | Short Hindi haan / nahi | T | current | no | yes | text run |
| T3 | Short Telugu అవును / కాదు | T | current | no | yes | text run |
| T4 | "Hindi mein baat kijiye" mid-booking | T | Hindi | on request | yes | text run |
| T5 | "Please speak in Telugu" | T | Telugu | on request | yes | text run |
| T6 | "Please speak in Gujarati" | T | Gujarati | on request | yes | text run |

T1–T6 are in suite `01M22ETHF4SMEDY6F089GSGM43`, IDs `01M7AKQG9QQG9Z4SX7V83AG02X` to `01M7AKQJW11RSTEKPGM4MS6CHJ`. None has been run. All earlier scenarios are kept.

**What to record for each B session** (read afterwards from Sarvam analytics, free):
- per-turn speech-recognition language tag and confidence;
- transcript;
- reply language;
- `average_agent_response_time`;
- interruptions;
- recording link.

## 5. Proposed budget (needs your approval)

| Step | Runs | Cost |
|---|---|---|
| 1. Browser voice V1 to V12, about 2 min each, in your browser | 12 | **₹0 expected**; I stop if the balance moves after V1 |
| 2. Text evals T1, T2, T3, T6, once each (T4 and T5 only if T6 fails) | 4 | **₹8.00** (₹12.00 if T4 and T5 also run) |
| 3. Optional: one real phone call to draft 5, after steps 1–2 pass. It needs a Sarvam phone test call to a verified test number (outbound) or a temporary deployment switch; either needs separate approval. | 1 call, about 3 min | **about ₹11.70** (3 × ₹3.50 + 6 × ₹0.20) |
| **Total** | | **₹8–12 for evals, plus about ₹11.70 if you approve the call** |

**Blocker:** the balance is −25.01. The 402 error on 13 Nov shows paid runs are refused at a negative balance.
- Steps 2 and 3 need at least 25.01 + 23.70 ≈ **49 credits**. Sarvam's top-up is ₹118 for 100 credits. You top up; I don't.
- Browser tests may also be refused while the balance is negative. Step 1 will show that.
