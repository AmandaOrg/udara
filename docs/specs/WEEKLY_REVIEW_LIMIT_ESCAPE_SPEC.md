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

- An amount is read the way people write one: `5000`, `5k`, `₦5,000`, `5000 naira`, `5000 a day`, `make it 5k`, `7000/day`, and a voice note transcribed as `Five thousand.` all count. Only the weekly review is this forgiving; wizard amount entry stays strict, because guessing an amount out of prose there would move money the user did not ask to move.
- An in-range amount applies for the rest of the current week, then the check-in is done. Answering on Monday adjusts that same day, and the total quoted back counts the days actually left rather than always seven.
- Too low or more than double the plan: Udara says so and still waits for another number.
- `cancel`, `stop`, or `nevermind`: Udara keeps the current limits and says so.
- Any other text: Udara says the limits are staying as they are, then handles the message normally. It is never dropped silently — a mistyped limit used to vanish with no trace, and re-tapping the button answered "that check-in has already been answered".
- A photo or a voice note is never treated as an answer. A captionless photo in particular is not an amount and no longer closes the wait on its way past.
- An active airtime, data, electricity or transfer wizard takes precedence. A number typed for a wizard is that wizard's, and `cancel` cancels the wizard, not the check-in.
- If no valid amount arrives within **24 hours** of the last Adjust or retry, the wait expires quietly and limits stay as they were.
- Only the current week's recap is answerable. An untapped bubble from a previous Sunday is not, because an override set from it would apply to a week already ending.

## Edge cases

- A number sent while the wait is still open is a limit, not a transfer amount. Diverting (non-amount) closes the wait first so a later `5000` can be a send.
- Completing without a new limit is the same as Keep: no weekly override.
- Stuck users unstick on the first non-amount message; no one has to send a number to escape.
- Short acknowledgements like "thanks" do not produce "glad that went through" after the wait was dropped, since nothing went through.

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
