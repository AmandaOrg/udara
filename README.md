# Kedu — v0

A strict, proactive financial agent on WhatsApp. See the PRD for full context.

## Status

This is a hand-written scaffold, not a `nest new` output — it was built in an
environment without npm registry access, so **nothing has been installed or
run yet**. First commands in Claude Code (or wherever you continue) should be:

```bash
npm install
docker compose up -d          # local Postgres
cp .env.example .env          # fill in real values
npx prisma migrate dev --name init
npm run start:dev
```

## Structure

```
src/
  prisma/       PrismaService + module (global, injectable anywhere)
  whatsapp/     Cloud API webhook (verify + inbound) and outbound sender
  rubies/       Account provisioning + transfer client — typed, TODO'd (you've built this before)
  allowance/    THE CORE ENGINE — window check, fee calculator, daily/weekly rollover
  onboarding/   Stage machine + conversation session storage
  tagging/      Recipient tag lookup/creation
  manager/      Settings-change request gate (7-day minimum, enforced server-side)
prisma/
  schema.prisma Data model: User, DailyAllowance, Recipient, Transaction,
                 OverrideHistory, SettingsChangeRequest, OnboardingSession
```

## What's real vs. stubbed

**Implemented (business logic, unit-testable now):**
- `WindowService` — 11AM–8PM check
- `FeeCalculatorService` — early-access / borrow fee math, surplus waiver
- `AllowanceService` — today's allowance, weekly rollover, spend classification
  (NORMAL / EARLY_ACCESS / BORROWED)
- `ManagerService` — the 7-day eligibility gate

**Stubbed with TODOs (deliberately — either you already have the pattern, or
it depends on decisions not yet made):**
- `RubiesService` — swap in your existing client/auth
- `WhatsappService` / `WhatsappController` — payload parsing depends on final
  message-routing shape
- `OnboardingService` — prompt design + structured-output extraction, once
  model choice is confirmed with Samuel

## First things to do in Claude Code

1. `npm install` and confirm it builds (`npm run build`)
2. `npx prisma generate` + `npx prisma migrate dev` against local Postgres
3. Write unit tests for `FeeCalculatorService` and `AllowanceService` against
   the exact figures in the PRD — this is the one mechanic the whole product
   depends on, so it's worth locking down before anything else
4. Wire `RubiesService` and `WhatsappService` against your existing patterns
5. Fill in `WhatsappController.receive()` routing once 1–4 are solid
