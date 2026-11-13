# Sarvam credit reconciliation, 13 Nov 2026

Sources (read-only, nothing spent):
- Sarvam usage API: `/api/dhan/org/usage/summary` and `/timeseries`, grouped by SKU at hourly granularity (Sarvam's finest).
- Balance: `/api/dhan/org/balance`.
- Payments: `/api/billing/collections`.
- Run IDs and times: the eval run IDs. These are ULIDs, so the creation time is encoded in the ID.

## Balance timeline

| Time (UTC) | Event | Credits | Balance |
|---|---|---|---|
| 13 Nov 12:26:17 | Top-up `01a1d4df-7782-789b-a13d-ae66bb9bc3be`, invoice `IN/26-27/0011312`: ₹118 paid, 100 credits (₹18 GST) | +100.00 | -7.01 → 92.99 |
| 12:28–12:32 | Eval batch 1: 20 simulated runs (10 draft 5 + 10 v4) | −40.00 | 52.99 |
| 13:20–13:24 | Eval batch 2: 39 simulated runs (26 draft 5 + 13 v4) | −78.00 | −25.01 |
| 13:24:45 | 14th v4 run refused, "Insufficient credits" | 0.00 | −25.01 |
| 13:49:59 | Balance last updated | | **−25.01** |

92.99 − 40.00 − 78.00 = −25.01: it matches exactly.

## Charges on 13 Nov (IST day), by Sarvam SKU

| SKU | Unit price | Quantity | Spend | When (UTC) |
|---|---|---|---|---|
| `simulated-run` (eval runs) | ₹2.00 per run, flat (not per minute) | 59 runs | ₹118.00 | 12:00 hour: 20 runs; 13:00 hour: 39 runs |
| `voice-call-60s-pulses` | ₹3.50 per minute | 7 min | ₹24.50 | 12 Nov 18:00 and 19:00 (the 00:15 and 01:09 IST real inbound calls) |
| `vobiz-30s-pulses` (telephony) | ₹0.20 per 30 s | 12 pulses | ₹2.40 | same two calls |

Both calls were before the top-up, so they are part of the earlier −7.01.

**Not billed at all:**
- the draft text chats (send_chat) at 13:18 and 13:41 UTC;
- the browser voice tests from 12:16 to 12:49 UTC;
- analytics and config reads.

## Every eval run (batch | version | created UTC | run ID | scenario | judge result | cost)

1 | v5 | 12:28:30Z | 01M7AE2ZMTT015D833RBRP12Y3 | Opening hours and location | 3/3 | ₹2.00
1 | v5 | 12:31:08Z | 01M7AE7SVR1HTJB1JH9R7X0TGC | All details in the first sentence | 4/4 | ₹2.00
1 | v5 | 12:31:11Z | 01M7AE7X6202PZV4QZZNT9X51Q | Caller corrects the date | 3/3 | ₹2.00
1 | v5 | 12:31:15Z | 01M7AE80KFBM5DWFGF1QEJRRJ8 | Insurance and EMI | 2/2 | ₹2.00
1 | v5 | 12:31:17Z | 01M7AE83B49VA2ZY3746R7DJCQ | Reschedule an existing appointment | 2/2 | ₹2.00
1 | v5 | 12:31:21Z | 01M7AE86N3MFT19QAYB9DFPSHE | Dental emergency | 3/3 | ₹2.00
1 | v5 | 12:31:25Z | 01M7AE8AH1YX0B499S65YRNMBN | Repeated question | 2/2 | ₹2.00
1 | v5 | 12:31:28Z | 01M7AE8E6FXDCKMZDZEW63KAHF | Unclear request | 2/2 | ₹2.00
1 | v5 | 12:31:31Z | 01M7AE8H0GKGDG8C40YXR2Z4EK | Unrelated request | 1/1 | ₹2.00
1 | v5 | 12:31:34Z | 01M7AE8M07H0GRK5QH01YCJSDF | Caller asks for a reminder | 1/1 | ₹2.00
1 | v4 | 12:31:46Z | 01M7AE8ZKW1W2JAZ9PN5EAN4BP | All details in the first sentence | 4/4 | ₹2.00
1 | v4 | 12:31:50Z | 01M7AE92WW49Z0ZZB5WHTDZ0Y1 | Caller corrects the date | 3/3 | ₹2.00
1 | v4 | 12:31:53Z | 01M7AE96252ST3VFKZ7N2EXCPH | Opening hours and location | 3/3 | ₹2.00
1 | v4 | 12:31:56Z | 01M7AE9935EFA4JNAF01JWG61W | Insurance and EMI | 2/2 | ₹2.00
1 | v4 | 12:31:59Z | 01M7AE9C0Q7FEGKF8AKY7SFGA1 | Reschedule an existing appointment | 2/2 | ₹2.00
1 | v4 | 12:32:02Z | 01M7AE9EY52DHZW7A0BTYH51WF | Dental emergency | 3/3 | ₹2.00
1 | v4 | 12:32:05Z | 01M7AE9J6240PDD5QEVD05735J | Repeated question | 2/2 | ₹2.00
1 | v4 | 12:32:08Z | 01M7AE9N50BS2PFYT6FG9H1XW9 | Unclear request | 2/2 | ₹2.00
1 | v4 | 12:32:12Z | 01M7AE9R9K4Z5KZGF3WDQ81T58 | Unrelated request | 1/1 | ₹2.00
1 | v4 | 12:32:15Z | 01M7AE9VTSYZSEWATM8E703DRH | Caller asks for a reminder | 1/1 | ₹2.00
2 | v5 | 13:20:27Z | 01M7AH248PPF9GWNJJXY5NE9GC | Greeting has no self-introduction | 1/2 | ₹2.00
2 | v5 | 13:20:31Z | 01M7AH27XCGTTDF7PKQNQ7XFN4 | Booking intent with date and latest time | 3/3 | ₹2.00
2 | v5 | 13:20:35Z | 01M7AH2BJBH9CZBYXXD61PD40C | Unsupported service is refused | 2/2 | ₹2.00
2 | v5 | 13:20:38Z | 01M7AH2EF2YWYD963PR24MZBHV | Ambiguous service is clarified | 1/1 | ₹2.00
2 | v5 | 13:20:41Z | 01M7AH2HMF0PVRRCY0040KJ79A | Hindi service name maps to configured service | 3/3 | ₹2.00
2 | v5 | 13:20:44Z | 01M7AH2ME8WRARBD257ZDS4ZQA | Telugu service name maps to configured service | 1/2 | ₹2.00
2 | v5 | 13:20:48Z | 01M7AH2QWTA8CP54WVP4V5S4EC | Telugu-English mixed request | 1/2 | ₹2.00
2 | v5 | 13:20:51Z | 01M7AH2TTHJBZ5VMGRP3E4YFPR | Hinglish request | 1/2 | ₹2.00
2 | v5 | 13:20:54Z | 01M7AH2XSTFV9D6V8Y5Y1JS9HZ | English to Telugu switch keeps context | 1/2 | ₹2.00
2 | v5 | 13:20:56Z | 01M7AH30E11RVHC5Y8Q67PFJGM | Gujarati caller | 1/2 | ₹2.00
2 | v5 | 13:20:59Z | 01M7AH339PJYTV993W1M2ASA7G | Requested time not free | 2/2 | ₹2.00
2 | v5 | 13:21:02Z | 01M7AH363ZVN2606S7F1D2PZG6 | Time correction | 1/1 | ₹2.00
2 | v5 | 13:21:06Z | 01M7AH39EHH1TDHHGS59T8JDPS | Phone agreement is not booking consent | 1/1 | ₹2.00
2 | v5 | 13:21:08Z | 01M7AH3CA29P5S334JRJNPQK38 | Failed booking and callback wording | 2/3 | ₹2.00
2 | v5 | 13:21:11Z | 01M7AH3F8ZNE3SZHKBFE8F23CB | Enquiry without booking push | 2/2 | ₹2.00
2 | v5 | 13:22:19Z | 01M7AH5GT2N558NYKYDPHAQ62Q | Names and times preserved | 1/1 | ₹2.00
2 | v5 | 13:22:22Z | 01M7AH5KWXVY0KTDASEMWKWZQ3 | All details in the first sentence | 4/4 | ₹2.00
2 | v5 | 13:22:25Z | 01M7AH5Q5R0ZKM38BZ2ZPJND8R | Caller corrects the date | 3/3 | ₹2.00
2 | v5 | 13:22:29Z | 01M7AH5TKP8X73PP97ATQH9PX6 | Opening hours and location | 3/3 | ₹2.00
2 | v5 | 13:22:32Z | 01M7AH5Y9ZXCQVKR3X3Y5EY98V | Insurance and EMI | 2/2 | ₹2.00
2 | v5 | 13:22:36Z | 01M7AH61SKEFZ8XTSQZ4QMCP0E | Reschedule an existing appointment | 2/2 | ₹2.00
2 | v5 | 13:22:39Z | 01M7AH64ZFMPYR86XD121M37T9 | Dental emergency | 2/3 | ₹2.00
2 | v5 | 13:22:42Z | 01M7AH6825RF0KF68EQATW5MJT | Repeated question | 2/2 | ₹2.00
2 | v5 | 13:22:46Z | 01M7AH6BD02C7WFXVXX5Q6200F | Unclear request | 2/2 | ₹2.00
2 | v5 | 13:22:49Z | 01M7AH6EVD8VBH2638R4C8MX5Q | Unrelated request | 1/1 | ₹2.00
2 | v5 | 13:22:53Z | 01M7AH6J5CQNPPK1G9ANNFV9HM | Caller asks for a reminder | 1/1 | ₹2.00
2 | v4 | 13:24:05Z | 01M7AH8RR3J2EKYMCR9E1P113M | Greeting has no self-introduction | 1/2 | ₹2.00
2 | v4 | 13:24:09Z | 01M7AH8WD9EX8NKYTFPZNW9J18 | Booking intent with date and latest time | 3/3 | ₹2.00
2 | v4 | 13:24:12Z | 01M7AH8ZR0E6KXM6Z3KMHHECAQ | Unsupported service is refused | 1/2 | ₹2.00
2 | v4 | 13:24:15Z | 01M7AH92YHW2SGNEHE1FD49NWG | Ambiguous service is clarified | 1/1 | ₹2.00
2 | v4 | 13:24:18Z | 01M7AH95R0D8XHRSGW4F5AJWPY | Hindi service name maps to configured service | 3/3 | ₹2.00
2 | v4 | 13:24:21Z | 01M7AH98RDZZH46X65TXN88GGE | Telugu service name maps to configured service | 2/2 | ₹2.00
2 | v4 | 13:24:24Z | 01M7AH9BP1YVC4F4XTGASQ4DPW | Telugu-English mixed request | 2/2 | ₹2.00
2 | v4 | 13:24:27Z | 01M7AH9ECDN558QRTTGKWWAH8A | Hinglish request | 1/2 | ₹2.00
2 | v4 | 13:24:30Z | 01M7AH9H7NMGK8P5P6703BH94X | English to Telugu switch keeps context | 2/2 | ₹2.00
2 | v4 | 13:24:33Z | 01M7AH9KZRZSWV0D3G88MD22KM | Gujarati caller | 0/2 | ₹2.00
2 | v4 | 13:24:36Z | 01M7AH9PZMAEZNRN3ZXTBP0ZH2 | Requested time not free | 2/2 | ₹2.00
2 | v4 | 13:24:39Z | 01M7AH9SVHY3W6YQYVW1NWV0BS | Time correction | 1/1 | ₹2.00
2 | v4 | 13:24:42Z | 01M7AH9X241ZQM8FBNBR25QTEA | Phone agreement is not booking consent | 1/1 | ₹2.00
2 | v4 | 13:24:45Z | 01M7AHA02TWJ7XGTJ9XQJTXF1B | (no result) | not run: insufficient credits | ₹0

## Duplicate or avoidable spend

- **Duplicates:** none. No scenario ran twice in one batch, and the two start errors (a malformed ID list) created no runs and no charges.
- **Avoidable, ₹52 (26 runs):** the batch 2 draft 5 runs went ahead before the new ClickAI Worker was deployed. The custom greeting and the callback flow were therefore not exercised, and these scenarios must be re-run to verify them.
- **Optional, ₹20 (10 runs):** re-running the 10 earlier scenarios on draft 5 in batch 2 was a regression check, not a requirement.
- **Overdraft, ₹25.01:** I did not check the balance (52.99) before starting batch 2, which needed about 80 credits. Sarvam allowed the balance to go negative until the 14th v4 run was refused.
