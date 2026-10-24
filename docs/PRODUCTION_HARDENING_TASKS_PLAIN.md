# Production hardening — plain-language task list

The same work as [`PRODUCTION_HARDENING_TASKS.md`](PRODUCTION_HARDENING_TASKS.md),
written for a non-technical reader. Numbering matches exactly, so the two can be read
side by side.

Everything below was found by reviewing Amanda while it was already live and handling
real customer money.

---

## Task 0 — Set up the paper trail

- **0.1** Write up everything the review found as a document in the codebase, so the findings don't only exist in a chat window.
- **0.2** Create a plan listing every fix and the reason for it.
- **0.3** Write down how the product is meant to behave after these changes.
- **0.4** Write down how the changes work under the bonnet, for whoever maintains this next.
- **0.5** Add the plan to the index of ongoing work so it can actually be found.
- **0.6** Record your sign-off, which our own safety rules require before anyone changes a security protection.

---

## Task 1 — Stop the leaks

- **1.1** Stop writing customers' PINs, ID numbers and dates of birth into our server logs. Every time someone filled in a form, all of it was being recorded in full.
- **1.2** Remove a leftover debugging line that did nothing.
- **1.3** Stop recording customers' bank account numbers and names in the logs whenever the bank notifies us about a payment.
- **1.4** Turn off chatty diagnostic logging by default, so this kind of detail can't leak back in by accident.
- **1.5** Add an automatic check that blocks any future change that would re-introduce the leak.
- **1.6** Refuse to start the app at all if the passwords that prove WhatsApp and the bank really sent us a message are missing. Before this, it would start anyway and accept fake messages from anyone.
- **1.7** Document that new requirement everywhere a developer would look, and delete the old note describing the risk we just removed.
- **1.8** Record honestly whether we actually verified the bank's message, instead of always claiming we did.
- **1.9** Make sure a brief failure at the bank during a transfer gives the customer a message instead of total silence.

---

## Task 2 — Make the money side correct

The largest and riskiest part of the work.

### 2a — Stop the same step running twice

- **2a.1** Make each step of a transfer impossible to run twice at the same moment. This is what made a genuine double-debit possible.
- **2a.2** Do the same for bill and airtime payments.
- **2a.3** Stop a forged payment notification from skipping the PIN step and marking a transfer as done.
- **2a.4** Stay quiet when a repeated notification is harmless, and raise a loud alarm only when something genuinely unexpected happens.
- **2a.5** Handle a fee record being written twice, instead of crashing.

### 2b — Count spending correctly

- **2b.1** Fix a bug where two purchases on the same day could each overwrite the other's total, so one of them silently disappeared from the customer's daily spending.
- **2b.2** Keep exact kobo amounts when recording spending, instead of rounding them.
- **2b.3** Stop an error when a customer's first message of the day lands at the same instant as the nightly reset.

### 2c — Add safety nets that catch stuck work

- **2c.1** Add a job that chases up bill payments the provider never confirmed. Nothing was checking on those at all, so the customer was never told and their allowance was never charged.
- **2c.2** Add a job that finds completed payments whose spending was never counted, and counts it against the correct day.
- **2c.3** Send a daily report of anything still unresolved after a week, so nothing sits forgotten.
- **2c.4** Put limits on all these jobs so they can't overload the database.
- **2c.5** Speak up about records that can never be fixed automatically, instead of skipping past them in silence.

### 2d — Stop waiting forever

- **2d.1** Give every call to the bank a time limit, sized to how long that kind of request should reasonably take.
- **2d.2** Add an overall time limit as a backstop. Before this, a call to the bank could hang indefinitely.

### 2e — Stop guessing what the bank meant

- **2e.1** Stop treating an error page from the bank's gateway as if it were a real answer.
- **2e.2** When we genuinely don't know whether a transfer went through, record it as "unknown, check again" instead of "failed". This is the bug that could tell a customer nothing was taken after their money had already left their account.
- **2e.3** Make sure a failure while listing banks or checking a meter number still lets the conversation carry on, rather than the bot going silent.

### 2f — Make sure we collect our own fees

- **2f.1** Make fee collection retryable, rather than getting permanently stuck after one failed attempt.
- **2f.2** Add a job that retries uncollected fees for up to 24 hours.
- **2f.3** Add the database fields that make those retries possible.

### 2g — Don't honour stale prices

- **2g.1** Re-check the price and terms when someone confirms a transfer they started a while ago, instead of using the old figures.
- **2g.2** Let a customer cancel a transfer that is sitting waiting for their PIN.

---

## Task 3 — Be able to run and watch the system

- **3.1** Add a status page the hosting platform can check, so a server that is running but can't reach the database gets restarted instead of quietly swallowing customer messages.
- **3.2** Let the app shut down cleanly during a redeploy, instead of dropping work halfway.
- **3.3** Make a startup failure show a real error message instead of looking like a mysterious crash loop.
- **3.4** Add error tracking, so failures are reported somewhere a person will actually see them.
- **3.5** Keep the full technical detail of an error. Previously all of it was thrown away, leaving a one-line note and no way to find the cause.
- **3.6** Add an overall ceiling on how many requests the app accepts per minute.
- **3.7** Cap how many messages one person can send in ten minutes, so a single bad actor can't run up our AI and transcription bill without limit.
- **3.8** Stop people who haven't signed up from triggering paid voice transcription.
- **3.9** Make sure reminder messages go out exactly once, even when two copies of the app are running.
- **3.10** Same for the managers' replies.
- **3.11** Stop one failed email from cancelling everyone else's.
- **3.12** Stop our own admin tools from accidentally running the scheduled jobs a second time against live customers.
- **3.13** Give the AI providers a time limit, so one hung request doesn't stall the whole conversation.
- **3.14** Stop a failure in our internal record-keeping from ruining an otherwise perfectly good reply.

---

## Task 4 — Make the database keep up

- **4.1** Speed up the main transactions table, which had no shortcuts at all despite being searched twice in every single conversation.
- **4.2** Speed up looking a customer up by phone number.
- **4.3** Speed up the settings-request and signup tables, which also had none.
- **4.4** Stop chat history growing forever, which was making every message slower than the one before it.
- **4.5** Fix a bug where sending the same kind of message twice would throw an error *after* it had already been delivered.
- **4.6** Fix a mismatch between our description of the database and the real one.
- **4.7** Document a sensible limit on database connections.
- **4.8** Package these database changes so they apply automatically on deployment.

---

## Task 5 — Keep the AI honest

- **5.1** Stop the AI supplying an account or meter number the customer never actually gave it — unless it is reading one off a photo they just sent, which is a real feature.
- **5.2** Stop the AI putting account numbers or web links into its replies that the customer never provided.
- **5.3** Clearly mark text that came from outside, such as a bank's version of someone's name, so the AI can't be tricked by what it contains.
- **5.4** Blank out a PIN or ID number if a customer types one into ordinary chat. Deliberately narrow, so it doesn't also wipe out phone numbers and break airtime purchases.
- **5.5** Make our two separate lists of "things to hide" actually match each other, despite a comment claiming they already did.
- **5.6** Give the AI a time limit during signup plus a fallback reply, so a provider hiccup doesn't leave a brand-new customer staring at silence.
- **5.7** Let someone say "help" or "start over" during signup and actually get out.
- **5.8** Remove a setting that current AI models reject outright, which would have broken every single conversation.
- **5.9** Fix a bug where a phone number was read from the wrong field.
- **5.10** Tell the voice transcription service to expect Nigerian English, and words like "naira" and the network names.

---

## Task 6 — Fix the Sunday weekly review

Thirteen problems in the most recent feature before this work started.

- **6.1** Stop the review hijacking answers that were meant for the transfer or bill screens.
- **6.2** Accept the way people actually write amounts. "5000 naira", "make it 5k" and "5,000." all previously did nothing at all.
- **6.3** Always reply when we stop waiting for an answer, instead of going quiet.
- **6.4** Stop the bot saying "glad that went through" when nothing went through.
- **6.5** Stop a photo with no caption being treated as an answer and closing the review.
- **6.6** Make a new limit set on Monday actually apply to Monday, and stop quoting a full week's total for a week that is already half over.
- **6.7** Fix a timing bug where two messages arriving together could reopen a review that had just been answered.
- **6.8** Remove a pointless database write.
- **6.9** Ignore taps on last week's review, which would otherwise set a limit for a week that is nearly finished.
- **6.10** Delete a piece of code that could never run.
- **6.11** Merge two identical copies of the "cancel" word list into one.
- **6.12** Merge three copies of the same database update into one.

---

## Task 7 — Tidy up

- **7.1** Replace real-looking phone and account numbers in our test files with obviously fake ones.
- **7.2** Delete the old system the AI replaced, which was still being loaded on every startup.
- **7.3** Correct documentation that described things inaccurately.
- **7.4** **Partially done.** Update the third-party libraries we safely could. 44 known issues remain, because fixing them requires a large framework upgrade we deliberately chose not to bundle with money-handling changes.

---

## Task 8 — Let people ask to change their limits or leave

The terms every customer agrees to promise they can ask to change their limits or
leave, that the request goes to "the managers", and that a waiting period applies.
None of it was reachable in the product. The only way to lift someone's restrictions
was for an engineer to edit the database by hand.

- **8.1** Formally record the decision to let the AI trigger this, which our safety rules require.
- **8.2** Let a customer ask, in ordinary words, to change their limits or to leave.
- **8.3** Restrict what such a request can contain to a fixed set of options plus a short reason.
- **8.4** Connect that request to the system that actually files it.
- **8.5** Confirm the AI still cannot move money, shorten the waiting period, or lift restrictions by itself.
- **8.6** Give operators a tool to approve or reject these requests, replacing hand-editing the database.
- **8.7** Stop a rejected request being quietly flipped to approved later.
- **8.8** Make approving a request and actually lifting the restrictions happen together, so it can't half-work and leave someone approved but still restricted.
- **8.9** Add tests, and correct the documentation that claimed this feature already worked.

---

## Task 9 — Final check before merging

- **9.1** Fix four code-quality errors that would have failed the automated build. One of them was already broken before this work started.
- **9.2** Apply the project's standard code formatting across 24 files.
- **9.3** Stop the new status page revealing where our database lives to anyone who visits it.
- **9.4** Fix a naming bug that would have caused a permanent false "something has changed" warning on every future database update.
- **9.5** Confirm the new libraries install cleanly on the production server.

---

## Still to do — needs a person, can't be done in code

**The first two are blockers. Do them before deploying.**

- **OPS-1** Check that the two passwords proving WhatsApp and the bank are genuine are set in our hosting environment. The app now refuses to start without them, so if either is missing today, the deploy will visibly fail instead of quietly accepting fake messages.
- **OPS-2** Treat all existing server logs as containing customer PINs and ID numbers, and delete or expire them. Task 1.1 stops new leaks; it does nothing about what has already been written.
- **OPS-3** Switch on error tracking and point the platform's health check at the new status page. Both are built but inactive until someone configures them.
- **OPS-4** Set a limit on database connections.
- **OPS-5** Ask the bank whether they detect duplicate transfer references. Several of our safety guarantees assume they do, and nothing has ever verified it.
- **OPS-6** Open the pull request and let the automated build run before merging. It applies the three database changes against a real database, which is the first genuine test of them.
- **OPS-7** Check how large two of our tables are before applying the speed-ups in Task 4. They're fine at today's size; if either has grown into the millions of rows, they need to be applied differently.

---

## Deliberately postponed — decisions, not oversights

- **DEF-1** Delete two unused columns holding ID numbers, and add a job that clears out old data. Both destroy data, so they belong in their own change with a backup taken first.
- **DEF-2** Upgrade the core framework. This is what the remaining library warnings in Task 7.4 actually need, and it is the riskiest change of the set.
- **DEF-3** Add a stronger guarantee that scheduled jobs never run twice. The current protection is good enough because of the fixes in Task 2a, but the hosting platform does briefly run two copies during a deploy.
- **DEF-4** Build a proper admin screen, so approving customer requests doesn't depend on someone remembering to run a command-line tool.
- **DEF-5** Reduce AI costs through caching.
- **DEF-6** All new feature ideas from the review, which were excluded from this work on purpose.

---

## Worth knowing — not fixed, your call

- **OBS-1** The overall request limit applies to everything together rather than per sender, including the bank's payment notifications. If it were ever hit, a customer could be credited without being told. It won't be hit at today's volume, but it is a ceiling worth knowing about as we grow.
- **OBS-2** The new status page has no test covering it.
- **OBS-3** The `main` branch currently fails the automated build for an unrelated pre-existing reason. This branch fixes it, but any other branch started from `main` inherits the problem.
