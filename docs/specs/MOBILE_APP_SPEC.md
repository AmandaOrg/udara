# Mobile app backend

Companion to [`initiatives/mobile-app/plan.md`](../../initiatives/mobile-app/plan.md) and [`docs/tech-design/MOBILE_APP_TECH.md`](../tech-design/MOBILE_APP_TECH.md).

## Status

Draft
Initiative: [`initiatives/mobile-app/plan.md`](../../initiatives/mobile-app/plan.md)
Tech design: [`docs/tech-design/MOBILE_APP_TECH.md`](../tech-design/MOBILE_APP_TECH.md)
Decision: [ADR-0002](../decisions/0002-app-channel-and-auth.md)

This spec covers P0 in full. Later phases are described at the level the product owner decided; each is filled in before its code starts.

## Problem

Udara can only be used from WhatsApp. People who don't want to manage their money inside a chat app, or who want a home screen, a history view and push alerts, have no way in.

## Goals

- A person can download the app, sign up with their phone number, and be onboarded by Udara in an in-app chat, just as on WhatsApp.
- Someone who already uses Udara on WhatsApp can log into the app with the same number and see the same account, balance and limits.
- Everything that protects the money still holds in the app:
  - the spending window;
  - allowances;
  - fees;
  - confirm then PIN;
  - the managers' seven-day wait.

## Non-goals

- Retiring WhatsApp.
- Voice notes or photos sent from the app (v1).
- Any way around the window, the allowance, or the managers' wait that exists only in the app.

## User-visible behavior

### P0 (on WhatsApp, today)

These changes ship before the app exists. They close gaps the app would otherwise have exposed.

- **Bill purchases are re-quoted like transfers.** If the user taps Confirm more than 10 minutes after the quote, or the fee or spend type has changed since (for example the window closed), Udara sends the card again with current figures under one line:
  - "this has been waiting a while, so let's confirm it again:" (stale), or
  - "the terms on this one moved while it was waiting, so here it is again:" (terms changed).

  The user confirms again before the PIN is asked for.
- **A purchase waiting on the PIN is withdrawn, not left behind.** An airtime, data or electricity purchase waiting on the PIN is cancelled when the user moves on to something else: a new bill purchase, another menu item or surface, or asking Udara to cancel. Udara says so ("Cancelled, no airtime was bought."), even though those paths otherwise cancel silently. Transfers already behaved this way.
- **Only the latest identity form can be submitted, and only once.** If the user submits an older KYC form (for example one reopened from earlier in the chat), Udara replies "that form has expired, here's a fresh one:" and sends a new one. Nothing is sent to the bank.
- **The message-flood limit now works.** A number that sends more than 40 messages in 10 minutes gets one "that's a lot of messages at once" reply, and further messages are ignored until the window passes. The limit was always meant to do this, but it never triggered.

### Later phases (outline)

- **Sign-up and login.**
  - The user enters their phone number and gets a 6-digit code by SMS.
  - On a new phone, if a PIN is already set, the user also enters the PIN.
  - Every new device is announced on the user's other channels and by email.
- **Onboarding.** The same conversation as WhatsApp in an in-app chat. The identity form and PIN entry are native screens, never chat messages.
- **Talk to Udara.** The same assistant and rules as WhatsApp, with a shared memory of what was done on either channel.
- **Native screens:** balance, limits and window, history, recipients, send money, airtime, data and electricity, settings requests, and devices. Sending money is still quote, then Confirm, then PIN.
- **Push notifications** for money in and out and for Udara's check-ins. The lock screen never shows amounts or account details.

## Edge cases

- **Bill quote is stale and the user cannot afford it any more.** The balance check runs before the re-quote, so this still fails with the existing "only has" message.
- **Two identity forms submitted at the same moment.** Only one reaches the bank; the other is treated as expired.
- **Tapping Cancel and Confirm on the same bill at the same moment.** Exactly one wins. Cancel can no longer overwrite a purchase that has already moved to the PIN step.
- **A KYC form open when this ships.** It is treated as expired once and replaced.

## Safety / PII

- No change to what is stored or logged. KYC values and PINs still travel only in memory.
- Confirm and cancel now check who is asking, not just which transaction is named. On WhatsApp this is defence in depth, because Meta signs every button tap. In the app it is the main defence.

## Acceptance (observable)

- A bill confirmed 11 minutes after its quote shows a fresh card and does not ask for the PIN.
- A PIN-awaiting bill is cancelled, with a message, when the user starts a new wizard.
- An older KYC form gets "that form has expired" and a new form, and no account is created.
- The 41st message within 10 minutes gets the flood notice, and later ones are ignored.

## Changelog

| Date | Change |
| --- | --- |
| 2026-09-25 | Initial: P0 behavior in full, later phases outlined |
