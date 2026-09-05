# ADR-0001: Let the model file a settings-change request

- **Status:** accepted
- **Date:** 2026-09-05
- **Deciders:** Egwu David Samuel

## Context

The terms every user consents to at `TERMS_CONSENT` say they can ask to change their limits or leave, that the request goes to "the managers", and that a minimum waiting period applies regardless of how the request is phrased.

None of that was reachable. `ManagerService.fileChangeRequest` and `reviewRequest`, the delayed-reply scheduler, the `SettingsChangeRequest` model and its seven-day `eligibleAt` gate all exist and are tested — but nothing outside `src/manager/` ever called them. There was no chat surface, no route, no CLI. The only way to lift a user's restrictions was a manual database edit, and `PRODUCT_BEHAVIOR.md` described the whole mechanism as "Verified".

So the product made a promise in writing that the code could not keep. For a discipline product whose entire trust proposition is "your money is never locked, only the restrictions are, and you can always ask", that gap is the most serious non-technical finding in the 2026-09-04 assessment.

Closing it means letting the model trigger something new, which `SECURITY.md` §4.7 says requires an explicit recorded decision. Hence this record.

## Decision

Add a `settings_request` surface the orchestrator may propose, and an authenticated operator path to decide the resulting requests.

What the surface may do:

- File a `SettingsChangeRequest` with a type drawn from a closed enum (`WINDOW_HOURS`, `OVERRIDE_FEES`, `EXIT_RESTRICTIONS`, `OTHER`), the user's own words as the requested change, and an optional bounded reason.
- Nothing else.

What it explicitly may not do, and what code still enforces:

- It cannot change a setting. Filing a request and changing a limit are different operations, and only the second one matters to a user's ability to spend.
- It cannot shorten, skip, or influence `eligibleAt`. That is computed once at filing from `SETTINGS_CHANGE_MIN_DAYS` and compared as a timestamp, so no phrasing reaches it.
- It cannot set `disciplineExitedAt`. That is still written only by `reviewRequest` on an approved `EXIT_RESTRICTIONS` decision.
- It cannot move money, and does not touch the transfer or bill paths.

Operator decisions go through a CLI on a restricted module, not an HTTP route. There is no admin authentication in this codebase, and inventing one to expose an endpoint that lifts spending restrictions would be a larger security decision than the one being made here.

## Alternatives considered

- **Leave it unreachable and correct the documentation instead.** Honest, and much cheaper. Rejected because the terms are what the user agreed to, not the docs, and "we wrote it down but did not build it" is not a defensible position for a consented commitment about someone's own money.
- **A deterministic keyword command, for example `manager exit`.** No new LLM reach at all. Rejected because a person asking to leave a discipline product is not going to guess a command, and the moment they most need it is the moment they are least willing to hunt for syntax. The orchestrator already handles every other intent.
- **An authenticated HTTP admin route.** Rejected for now: the app has no admin identity model, and the first thing such a route would do is lift spending restrictions. A CLI run by someone who already holds database credentials grants no new authority.
- **Let the model apply approved changes directly.** Rejected outright. The delay is the product.

## Consequences

- The LLM's reach widens by exactly one non-money action. The validator still gates it, and an ineligible or low-confidence proposal still degrades to `reply_only`.
- A user can now file a request in ordinary language, and the seven-day wait starts from that moment rather than from whenever someone notices.
- Requests accumulate and need a human to decide them. Without an operator habit, a filed request becomes a promise that is acknowledged and then ignored, which is worse than the current state of not accepting them at all. The CLI is the minimum; an ops console is recorded as follow-up work.
- `reviewRequest` is now guarded by status, so a rejected request cannot later be flipped to approved, and approval plus the restriction lift happen in one transaction rather than as two writes that could half-apply.

## Follow-up

- Spec: [`docs/specs/PRODUCTION_HARDENING_SPEC.md`](../specs/PRODUCTION_HARDENING_SPEC.md), settings-change section
- Tech design: [`docs/tech-design/PRODUCTION_HARDENING_TECH.md`](../tech-design/PRODUCTION_HARDENING_TECH.md)
- Initiative: [`initiatives/production-hardening/plan.md`](../../initiatives/production-hardening/plan.md), Phase 8
- Deferred: an operator console, so decisions are not gated on someone remembering to run a CLI
