# Weekly review limit escape

**Status:** Draft  
Initiative: [initiatives/weekly-review-limit-escape/plan.md](../../initiatives/weekly-review-limit-escape/plan.md)  
Tech design: [../tech-design/WEEKLY_REVIEW_LIMIT_ESCAPE_TECH.md](../tech-design/WEEKLY_REVIEW_LIMIT_ESCAPE_TECH.md)

## Problem

After **Adjust limits**, Udara treated every message as a daily-limit number. Users who said hello, asked for balance, or tried to send money were stuck on “that didn’t read as an amount” — including the day after a too-high number was rejected.

## Goals

- Only a clear amount answers the weekly-limit prompt
- Other intents leave that prompt and get a normal reply
- A leftover wait cannot block chat the next day or next Sunday

## Non-goals

- Changing how high they may set a self-serve weekly limit (still 2× the derived plan)
- Letting chat rewrite the limit in ordinary language without a number
- Changing transfer or bill amount entry

## User-visible behavior

Sunday recap, Keep vs Adjust, and a valid in-range number still work as today.

After **Adjust limits**:

- A parseable amount in range is applied for the coming week only, then the check-in is done.
- Too low or more than double the plan: Udara says so and still waits for another number (they can retry up to the stated ceiling).
- `cancel`, `stop`, or `nevermind`: Udara keeps the current limits, says so, and does not also answer as if this were a new chat turn.
- Any other text that is not an amount (greetings, “what’s the balance”, “I want to send money”, menu words): the limit prompt is dropped with no extra “didn’t read as an amount” line. The same message is handled as a normal post-onboarding turn.
- If they never send a valid amount within **24 hours** of the last Adjust (or last too-low / too-high retry), the wait expires. Limits stay as they were. The next message is a normal turn.
- A new Sunday recap closes any leftover wait from an earlier week so that recap’s buttons are not sitting behind an old number prompt.

## Edge cases

- A number sent while the wait is still open is a limit, not a transfer amount. Diverting (non-amount) closes the wait first so a later `5000` can be a send.
- Completing without a new limit is the same as Keep: no weekly override.
- Stuck users unstick on the first non-amount message after this ships; no one has to send a number to escape.

## Safety / PII

No PIN, KYC, or money movement. The override is still written only from a parsed amount after Adjust, then allowance code applies it for one WAT ISO week.

## Acceptance (observable)

- `Hi` / `what's the balance` after Adjust get a normal reply, not the amount-retry line
- `7000` over the ceiling still gets the double-plan refusal and can retry with a lower number the same day
- `cancel` keeps current limits and stops
- After 24 hours with no valid amount, chat is no longer trapped
- Next Sunday’s recap is not blocked by last week’s unanswered Adjust

## Changelog

| Date | Change |
| --- | --- |
| 2026-09-02 | Initial |
