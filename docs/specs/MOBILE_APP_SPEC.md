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

### P4 (in-app conversation)

- **The app chat is the WhatsApp conversation.** A new user opens the chat and Udara introduces itself, as it does to a first WhatsApp message. Buttons and lists appear as tappable choices. Everything after that (terms, the four questions, the plan, "talk to Udara") is the same script and the same assistant.
- **Forms are native screens.** When Udara asks for identity details or a PIN, the chat shows a card that opens a native form. Submitting it returns to the chat, where the result arrives as it does on WhatsApp: the account number, or what was wrong and a fresh form.
- **An app-only user sets a PIN straight after the account is created.** Udara says "one more thing before we carry on: set the 4-digit pin…" and does not carry on with onboarding until it is set. WhatsApp users are unchanged: their PIN is still first asked for at their first transfer.
- **A phone signed in less than 24 hours ago can send at most ₦20,000 in total** (configurable) until the 24 hours are up. A payment that would go over is cancelled after the PIN, before any money moves, with how much is left and when the limit lifts.
- **Switching channel closes what was left open.** A transfer or airtime wizard, a pending pick between saved recipients, or a weekly "what limit do you want?" left open on one channel is quietly closed when the user writes on the other. Anything waiting on a Confirm button or a PIN is not affected.
- **One conversation at a time per person.** A message that arrives while Udara is still answering the previous one (on either channel) waits for it, rather than both being handled at once.
- **One message-flood budget across both channels:** 40 messages in 10 minutes in total. In the app, a message over the limit is refused rather than answered.
- **If handling a message fails, the app says so** ("sorry, something went wrong on my side…"). WhatsApp stays silent, as today.

Edge cases:
- **The app sends the same message twice** (a retry after a dropped connection): it is handled once.
- **The app names a choice that was never offered**, or one offered to someone else: 404, and nothing is recorded.
- **The PIN or BVN is typed into the chat instead of the form:** it is scrubbed before it is stored, as on WhatsApp.

### P5 (push and delivery rules)

Messages Udara sends when the user hasn't just written (money arriving, a transfer that finished later, the daily "your day is unlocked", the weekly check-in, the managers' answer) now go where the user will see them:
- **A transfer or purchase result** goes back to where it was started: the app or WhatsApp.
- **Everything else** goes to whichever of the two the user used last.
- **WhatsApp only while Meta allows it.** WhatsApp refuses ordinary messages more than 24 hours after the user last wrote there, and fails them silently. For someone who also has the app, such a message goes to the app instead. Someone who has never used the app gets exactly what they get today.
- **One alert per event.** A WhatsApp message is its own alert. Anything that lands only in the app raises a push notification. Several messages at once (a recap and its buttons) raise one push, not several.
- **A push never shows an amount, a name or an account number.** It says "There's an update on your Udara account." or "Udara has a message for you." and opens the chat.
- **The app's chat shows the whole story.** Anything sent to WhatsApp is also added to the app chat, silently, for someone who has signed in to the app.
- **Only signed-in phones get pushes.** Signing out, or a session revoked as stolen, stops them. When a phone signs in as someone else, the previous account's pushes stop reaching it.
- **Sign-in approvals and new-device warnings always go to WhatsApp**, never to the app: the warning is for the other phone.

### P6 (read-only screens)

The app can show, without going through the chat:
- **Balance**, always fetched live from the bank, as on WhatsApp.
- **Limits:** what is left today and this week, whether the spending window is open or how long until it opens, and whether restrictions are off. These are the same figures and wording rules as the WhatsApp "Limits" reply, from one place.
- **Account details** for funding: account number, name and bank.
- **History:** transfers, airtime, data and electricity purchases, and money received, newest first. It shows what the user committed to: done, still processing, or failed. Quotes that were never confirmed and cancelled ones are left out. An electricity purchase shows its token once it is bought.
- **Saved recipients**, most recently used first, with their bank's name.
- **Spend summary** for this week or this month. Like the weekly check-in, it counts transfers only.
- **What can be bought:** networks, data bundles, electricity companies, and the amount limits, as the WhatsApp wizards offer them.
- **Check an account's name** before sending to it. At most 20 checks an hour per person. Only someone whose account is open can check, so a phone that has only signed up cannot use it to find out who owns accounts.
- **Is this app version still supported?** This is readable before sign-in, and tells an old app to show an update screen.

Before the account is opened, balance, limits and account details answer "no account yet", and the lists are empty. Nobody can see another person's data: the user always comes from the session, never from the request.

### P7 (sending money from the app's own screens)

The app can send money without the chat, with the same steps and the same protections:
1. **Quote.** The user picks the recipient and amount and sees what the chat's card shows: the recipient's name (a new recipient is checked with their bank first), the amount, any window or borrowing fee, the balance after, and what is left of today's allowance.
2. **Confirm.** The same checks as the chat's Confirm button, in the same order.
   - Not enough money: the send is cancelled and the app says how much is needed.
   - The figures moved while it waited (the window closed, or more than 10 minutes passed): the app shows the new figures, and the user confirms again.
   - No PIN yet: the app asks the user to set one first.
   - PIN locked: the send is cancelled and the app says so.
3. **PIN**, on a native screen.
   - A wrong PIN says how many tries are left and asks again.
   - A lockout cancels the send.
   - On a phone signed in less than 24 hours ago, the new-phone limit (₦20,000 by default) applies exactly as it does to a PIN entered in the chat.
4. **Result:** sent, still processing, or failed. A result that arrives later reaches the app with a push.

Also:
- **Nothing is sent twice.** If the connection drops and the app asks again for the same send, it gets the same transfer back, not a second one. The same retry id reused for a different send is refused.
- **The chat and the send screens stay out of each other's way.** A send started on the screens never shows a card or PIN form in the chat, and typing "cancel" in the chat does not cancel it. Its result is still added to the chat, like any payment's.
- **A send can be cancelled** from the screen until the PIN is accepted.
- **WhatsApp users see no change.** Every card, message and button is word for word the same.

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
| 2026-09-26 | P6: read-only screens |
| 2026-09-26 | P7: sending money from the app's screens |
