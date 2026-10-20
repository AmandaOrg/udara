# Production hardening — spec

## Status

Draft
Initiative: [`initiatives/production-hardening/plan.md`](../../initiatives/production-hardening/plan.md)
Tech design: [`docs/tech-design/PRODUCTION_HARDENING_TECH.md`](../tech-design/PRODUCTION_HARDENING_TECH.md)

## Problem

Most of this work is invisible to users when it succeeds. Four of the defects are not.

1. **A customer can be told their transfer failed when the money left their account.** When Rubies answers with a gateway error rather than a normal response, Amanda reads it as a definite failure, says "nothing was deducted", and never checks again.
2. **A customer can be charged twice.** Tapping Confirm twice, or answering two PIN prompts for the same transfer, can send the same transfer to the bank twice. Nothing on our side prevents it.
3. **A customer can spend past their own limit without paying the override fee they agreed to.** Three ₦8,000 sends can each be checked against the same ₦10,000 of headroom and all go through as normal spending. A send set up inside the window and confirmed at 23:00 escapes the outside-hours fee.
4. **A customer's PIN, BVN and date of birth are written to our logs in plain text.** Nobody outside the team sees them, but everyone inside does, and the terms say we do not store them.

Two smaller ones users do meet: the Sunday "adjust my limit" answer is silently discarded when phrased naturally, and a bank hiccup while confirming produces no reply at all.

## Goals

- A transfer is never reported as failed unless it definitely failed.
- The same transfer never reaches the bank twice, whatever the customer taps.
- Daily allowance and the spending window cannot be exceeded without the agreed fee.
- Secrets and identity numbers never appear in a log line.
- Forged webhooks are rejected in every deployed environment.
- Money that moved is always reflected in the allowance; a fee that was charged is always collected or written off deliberately.
- The Sunday limit answer works when phrased the way people actually phrase it.

## Non-goals

- New product features. The proposals in the assessment are recorded, not built.
- Changing the discipline model: window hours, the 30% formula, and the fee amounts stay as they are.
- Changing the persona voice.
- Deleting customer data. All destructive database work is deferred.

## User-visible behavior

**Transfers.** Unchanged on the happy path: confirm, then PIN, then the money moves and a receipt arrives.

When the bank's answer is unclear, the customer is told it is being processed rather than that it failed, and the outcome arrives once it is known. When they tap Confirm twice, exactly one transfer happens and they see one receipt.

If the terms changed between setting up a send and confirming it, because the spending window closed or the allowance moved, the confirm screen is shown again with the new fee. Nothing executes on figures the customer has not seen. Resuming an older pending transfer keeps working; it re-quotes rather than silently dying.

If the balance check fails while confirming, the customer is asked to tap Confirm again in a moment, instead of getting no reply.

**Bill payments.** Same guarantees as transfers, including recovery of a purchase whose outcome was never confirmed.

**Fees.** An override fee that could not be collected at the time is retried for up to 24 hours. After that it is written off and flagged internally, never charged as a surprise debit days later.

**The Sunday review.** "Adjust limits" now accepts the natural phrasings: `5000 naira`, `make it 5k`, `5000 a day`, and a spoken "five thousand". The wait is never dropped without saying so. Sending a photo or starting an airtime purchase no longer cancels it silently, and typing `cancel` during an airtime purchase cancels the purchase, not the limit change. An answer given the next morning applies to that day's allowance, and the confirmation states the correct weekly total for the days remaining.

**Onboarding.** If the assistant fails to respond, the customer gets a "say that again?" rather than silence, and can type `restart` or `help` at any point before their account exists.

**Voice notes and photos.** Unchanged, except that spoken amounts are recognised more reliably.

**Settings changes and leaving.** New, and the reason it is in scope: the terms customers consent to describe filing a change and waiting seven days. Until now nothing in chat could reach that. A customer can now ask to change their limits or leave, the request is filed, the seven-day minimum still holds regardless of phrasing, and the managers reply on the existing delay.

## Edge cases

- Two messages arriving in the same instant must not produce two transfers, two limit overrides, or two nudges.
- A deploy that overlaps old and new instances must not double-send scheduled messages.
- A transfer confirmed just before the spending window closes is re-quoted, not silently repriced.
- A customer typing their BVN or PIN as a chat message has it scrubbed before storage, while an 11-digit phone number for airtime still works.
- A limit answer arriving after the check-in has closed is told so, rather than being read as ordinary chat.
- A transfer stuck unresolved for more than a week is alerted on rather than retried forever.

## Safety / PII

- No log line may contain a PIN, OTP, BVN, NIN, date of birth, or access token. A new automated invariant enforces this.
- Webhook signature verification is required unless an environment explicitly opts out, and the opt-out is visible in configuration rather than implied by a blank value.
- Whether a webhook was actually verified is recorded truthfully.
- Account numbers, phone numbers and meter numbers proposed by the model are used only when the customer supplied them or they were read from a photo the customer sent this turn.
- The assistant's replies cannot introduce an account number or link the customer never mentioned.
- BVN and NIN continue never to be written to the customer record.

## Acceptance (observable)

- [ ] A gateway error during a transfer results in "processing", then a correct outcome, never a false failure.
- [ ] Two Confirm taps produce one transfer and one receipt.
- [ ] Three sends that each fit the remaining allowance individually cannot all execute fee-free.
- [ ] A Flow reply containing a PIN produces no log line containing it.
- [ ] Startup fails when a webhook secret is missing and no opt-out is set.
- [ ] Money that moved always appears in the allowance, including when the follow-up work fails partway.
- [ ] `5000 naira` sets the weekly limit; `cancel` during an airtime purchase cancels the purchase.
- [ ] A settings-change request filed in chat cannot be approved before its eligible date.

## Changelog

| Date | Change |
| --- | --- |
| 2026-09-04 | Initial |
