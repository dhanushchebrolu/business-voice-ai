# Draft 5 voice test script (browser, no phone)

**Where:** Sarvam dashboard, agent `Conversatio-9c6a04cd-3334`. The header must say **v5 · Draft**.

1. Open **Test agent**.
2. Choose the **Voice** tab.
3. Click **Start Call** and allow the microphone.

This is a browser call to the draft, so the production number and deployment are not involved. The caller identity is the Sarvam account email. ClickAI treats any email caller as a test: it checks the slot but never saves a booking or lead, and sends no notifications.

Use a quiet room. Speak naturally. Run one call per row and hang up between calls.

| # | Covers | What to say |
|---|---|---|
| 1 | Telugu, booking, correction | Telugu: "నాకు రేపు సాయంత్రం 5 గంటలకి teeth cleaning appointment కావాలి." When asked for a name, say "Ravi". Then correct the time: "కాదు, 4 గంటలకి." Confirm, then say "థాంక్స్, బై". |
| 2 | English | "Hi, what are your timings and how much is a root canal?" Then "Okay, that's all, bye." |
| 3 | Hindi | "Namaste, mujhe kal subah dant saaf karwana hai." Give the name "Meena". After the agent answers, say "Nahi, Sunday ko." |
| 4 | Code-switching | Start in Telugu, switch to English mid-sentence: "నాకు consultation కావాలి, actually can I come on Monday at 11?" Then reply only in English. |
| 5 | Interruptions | Ask "What services do you offer?" While the agent is still talking, cut in with "Sorry, just the price of cleaning." Do this twice. |
| 6 | Silence | After the greeting, say "Hello", then stay silent. Expect a nudge at about 20 s and the call to end at about 40 s. |
| 7 | Name and service correction | "Book a filling for Saturday 10 am, name Kiran." Then "Sorry, not a filling, a cleaning. And the name is Kiran Kumar." |

After the calls, tell me "done". I will then:
- read every interaction: transcripts, per-turn latency, detected language, tool calls and the recording link;
- check production ClickAI for new bookings or leads (there should be 0).
