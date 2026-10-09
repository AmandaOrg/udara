# ADR-0003: Account closure and data retention

- **Status:** accepted
- **Date:** 2026-10-09
- **Deciders:** Egwu David Samuel. He delegated the decision on 2026-10-09 ("check the Rubies agreement and NDPA online and make our (safe) decision for us"). Researched and drafted by Claude.

This is not legal advice. Have a Nigerian data protection lawyer, or a licensed data protection compliance organisation (DPCO), review it before the app launches.

## Context

The app stores require a way to delete an account from inside the app. Apple's guideline 5.1.1(v) and Google Play's account-deletion policy both require it. ADR-0002 left the deletion and retention policy open until P9. Udara cannot simply delete everything on request, because some of what it holds is a financial record that the law says must be kept.

**What Udara holds about a person:**
- **Identity, from the KYC form:**
  - legal name;
  - date of birth;
  - email;
  - phone number;
  - the Rubies customer id, account number and account name Rubies returns.

  The BVN or NIN is passed to Rubies and not stored. The `bvn` and `nin` columns are unused.
- **The plan and profile:** income, budget, goals, spending window, limits, friendly name, occupation and city.
- **Payments:**
  - transfers, each linked to the recipient account it paid;
  - airtime, data and electricity purchases;
  - money received;
  - fees.
- **The conversation**, on WhatsApp and in the app.
- **Working data:**
  - drafts;
  - the assistant's working memory and model-call logs;
  - devices, sessions and push tokens;
  - sign-in codes;
  - the email delivery log;
  - reminders and weekly reviews.

**What the law says.**

| Source | Rule |
| --- | --- |
| [NDPA 2023](https://ndpc.gov.ng/) s.24(1)(d) | Personal data is "retained for not longer than is necessary to achieve the lawful bases for which the personal data was collected or further processed". |
| NDPA s.25(1)(b)(ii) | Compliance with a legal obligation is a lawful basis for processing. |
| NDPA s.34(1)(d), s.34(2) | A data subject has a right to erasure "without undue delay". A controller must erase data once it is no longer necessary, or once there is no other lawful basis to keep it. |
| [GAID 2025](https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf) Art. 38(2)(b)(i), (d) | The right to be forgotten gives way where processing is needed "to comply with a legal ruling or obligation" or "for the establishment of a legal defence or in the exercise of other legal claims". |
| GAID schedule on s.24(1)(d) | Data kept "solely for record purposes" must be the minimum needed. "Any residue of data that is not needed should be properly destroyed or irreversibly de-identified." The retention policy must be told to data subjects. |
| GAID Art. 21(2) | Where a contract "did not materialise", the data collected must be destroyed within six months, unless it is needed for a future legal claim. |
| GAID Schedule 9 | A controller served with a data subject's demand must decide it within 30 days. |
| [MLPPA 2022](https://lawcarenigeria.com/money-laundering-prevention-and-prohibition-act-2022/) s.8(1)(a) | Transaction records are kept "for at least five years following completion of the transaction". |
| MLPPA s.8(1)(b) | Customer identification records, "including account files and business correspondence", are kept "for at least five years following the termination of the business relationship". |
| CBN AML/CFT/CPF Regulations 2022, reg. 35(1), (3) | The same five years, for transactions, identification data, account files and business correspondence. Reg. 35(1) adds "or such longer period as may be required by the CBN and other competent authorities". |
| CBN AML/CFT/CPF Regulations 2022, reg. 35(4) | Records are produced to the CBN within 48 hours. |
| CBN AML/CFT/CPF Regulations 2022, reg. 36(1) | The same five years for identification evidence. |
| Tax and civil claims | A tax assessment, and a civil claim over a contract, can generally be raised for six years. FIRS (now the Nigeria Revenue Service) advises keeping records for six years. This comes from secondary sources: the record-keeping section of the Nigeria Tax Administration Act 2025 was not checked. |
| [Apple](https://developer.apple.com/support/offering-account-deletion-in-your-app) | Users must be able to start deletion in the app. "Only offering to temporarily deactivate or disable an account is insufficient". Tell people what is kept when the law requires keeping it. A manual process is fine if the app says how long it takes and confirms when it is done. Apps in highly regulated industries may use customer-service steps. |
| [Google Play](https://support.google.com/googleplay/android-developer/answer/13327111) | An in-app path, plus a web link where deletion can be requested. Data may be kept "for legitimate reasons such as security, fraud prevention or regulatory compliance". |

**Rubies.**
- The signed Rubies partnership agreement is not public and was not reviewed.
- Rubies' [public privacy policy](https://rubies.ng/privacy-policy.html) gives no retention periods and no closure process.
- As a CBN-licensed microfinance bank, Rubies is bound by MLPPA s.8 and CBN regulations 35–36. A partner agreement normally passes those duties on to the partner.
- This decision meets them on Udara's side. The owner should still check the agreement (see Follow-up).

**Which of Udara's own duties apply?** Udara is not the bank. It instructs payments on its customers' behalf and keeps their instructions and payment records. The safe reading is that MLPPA s.8 applies to those records, directly or through the Rubies agreement.

## Decision

**1. Asking to close an account.**
- **In the app:** Settings, then Close account (`POST /v1/account/deletion`). The PIN is required if one is set, under the same lockout as payments.
- **By asking in chat, or by email:**
  - Ops confirms it is the account holder, for example that the request came from the account's own WhatsApp number or email address.
  - Ops then files it with `npm run account:request`.
  - The chat model cannot file a closure itself (section 6).
- **One open request at a time.**

**2. When an account can be closed.**
- The balance is zero, checked live with Rubies, when the request is filed and again at closure.
- No payment is in flight and no fee is still being collected.
- If a small amount cannot be moved out (a bank charge, for example), ops arranges it with Rubies before closing. Ops then closes with `--residual-handled`.
- Udara never pays a balance out itself at closure. That would be a money path outside the PIN (S17) and a target for fraud.

**3. The wait and the deadline.**
- The request becomes eligible 7 days after it is filed. Until then, the user can withdraw it: in the app, or by asking.
- Closing erases data and cannot be undone. The wait protects against a mistake and against a stolen phone.
- Ops closes the account within 30 days of the request, the period GAID Schedule 9 allows for acting on a data subject's demand.
- The app shows the date the closure is due.
- If ops declines (a regulator's or court's hold), the user is told why.

**4. What closing does.**
- Sends the confirmation first, by email and in the chat, while there is still a channel to send it on.
- Deletes every session and device. The app is signed out everywhere, and pushes stop.
- Releases the phone number and WhatsApp number. A recycled number then starts a new account, and the closed one can never be signed in to again.
- Erases, or keeps, the data as set out below. This happens in one database transaction, under the user's turn lease, so no message in progress can write data back.
- Prints the Rubies account details for ops. Ops then asks Rubies to close the bank account.
- Treats any later credit to the old account number as a money record, and alerts ops. Nobody is messaged.
- Withdraws any other request the user still had open with the managers.
- Sends nothing more to the user. Schedulers skip closed accounts, and the delivery policy drops anything addressed to one.

**5. What is kept, and for how long.** For someone who opened a bank account:

| Data | Kept | Why |
| --- | --- | --- |
| Identity from account opening: legal name, date of birth, email, phone number, Rubies customer and account details, and when the account was opened, consented and closed | 6 years after closure | MLPPA s.8(1)(b); CBN regs 35(3), 36(1). The sixth year keeps the payment records attributable while a claim can still be made |
| Payment records: transfers and the account each one paid, bill purchases and their tokens, money received, fees and overrides | 6 years after closure | MLPPA s.8(1)(a) and CBN reg 35(1): five years after each transaction. Six years covers claims and tax assessments (GAID Art. 38(2)(d)) |
| The conversation on both channels | 6 years after closure | Business correspondence: MLPPA s.8(1)(b); CBN reg 35(2)(f), (3). It is also the record of what the user instructed |
| Settings and closure requests, and how they were decided | 6 years after closure | Account files (CBN reg 35(3)), and the evidence that this request was handled |
| Everything else (see below) | Erased at closure | NDPA s.24(1)(d), s.34(2): no longer needed, and no other lawful basis |

"Everything else" is:
- the plan, income, goals, window and limits;
- the friendly name, occupation and city;
- the PIN;
- recipients that were never paid, and nicknames on those that were;
- devices, sessions, push tokens and sign-in codes;
- drafts, the assistant's working memory and the model-call logs;
- the email delivery log;
- reminders, weekly reviews and the daily allowance ledger.

**Someone who never opened a bank account** has no business relationship and no payment record. Everything is erased at closure. Only a de-identified record stays: when closure was requested and done.

**What happens to kept data:**
- It is used for nothing else. It is produced only to the account holder or a competent authority.
- A legal hold extends it: a regulator, court or investigation that needs records for longer (CBN reg 35(1)).
- After the six years it is destroyed, or irreversibly de-identified where only aggregate figures are still needed.
- One date per account, six years after closure, keeps that purge simple to run and to audit.

**6. What does not change.**
- **The chat model's settings types stay** `WINDOW_HOURS`, `OVERRIDE_FEES`, `EXIT_RESTRICTIONS` and `OTHER`. A request to close made in chat reaches ops as an ordinary request. Letting the model file a closure would widen what it can trigger, which needs its own decision (`SECURITY.md` §4.7).
- **The managers' persona does not answer a closure request.** Holding someone's stated goal against them when they ask to leave would make leaving harder than it should be.

**7. New invariant, S18.** Enforced by `scripts/check-security.js`:
- no code deletes a transfer, bill payment, credit, override or settings request;
- the model's settings types never include `ACCOUNT_DELETION`;
- only the closure service and the ops CLI close an account.

## Alternatives considered

- **Delete everything on request.** Rejected: for an account holder it breaks MLPPA s.8 and CBN regs 35–36.
- **Deactivate and keep everything.** Rejected: Apple calls deactivation "insufficient", and NDPA s.34(2) requires erasing what is no longer needed.
- **Keep for five years.** It meets the anti-money-laundering minimum. Rejected because claims and tax assessments run for six years, and records that can no longer be tied to a person are no defence.
- **Close automatically after the 7 days.** Rejected for now. The Rubies account must be closed by a person, and a closure has to be checked against holds first. Apple allows a manual process if the app says how long it takes.
- **Pay out the remaining balance at closure.** Rejected: it would move money outside the PIN and `PinOutcomeService`, to an account named in the closure request.
- **Let the chat model file a closure.** Rejected for now: see Decision, section 6.

## Consequences

- Closure needs an operator. A request left undone past 30 days breaks this policy. So the CLI lists every open closure request with the date it is due, and the plan records an ops console as follow-up.
- The kept data must be produced within 48 hours when the CBN asks (reg. 35(4)). Today that means a database query run by someone with access.
- A closed account's phone number becomes free. Someone who closes and signs up again starts from scratch, with a new Rubies account.

## Follow-up

- **Check the Rubies agreement** for three things:
  - a retention period longer than six years;
  - a notice or procedure Rubies needs when a customer closes;
  - any duty to hand records to Rubies at closure.

  A longer period means changing one constant (`src/account-closure/retention-policy.ts`).
- **Tell people.** The public privacy notice must carry the table above (GAID Art. 27 and the schedule on s.24(1)(d)). The terms summary's "your data" bubble should say it too. Bump `TERMS_VERSION` when it changes; P9's re-consent check then asks app users. WhatsApp re-consent needs its own design.
- **Google Play** needs a web page where someone can ask for deletion without the app. It can point to the in-app path, the chat, and an email address that ops reads.
- **Already owed, not started:** GAID Art. 21(2) requires destroying, within six months, the data of people who started onboarding and never opened an account. That is a purge job, deferred under the production-hardening decision (DEF-1) to a separate change with a backup taken first. It should be next.
- **The six-year purge.** Build it, with legal holds, before the first closure reaches six years (October 2032 at the earliest).
- Initiative: [`initiatives/mobile-app/plan.md`](../../initiatives/mobile-app/plan.md), Phase 9
- Spec: [`docs/specs/MOBILE_APP_SPEC.md`](../specs/MOBILE_APP_SPEC.md), P9
- Tech design: [`docs/tech-design/MOBILE_APP_TECH.md`](../tech-design/MOBILE_APP_TECH.md), P9
