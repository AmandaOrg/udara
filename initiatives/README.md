# Initiatives

Living execution records. Product behavior lives in [docs/specs/](../docs/specs/README.md). Implementation lives in [docs/tech-design/](../docs/tech-design/README.md). This folder answers **what is in flight and how far it got**.

## When a plan is required

Write an initiative **before** production code for anything that:

- Changes money movement, PIN/KYC, routing, or orchestrator actions
- Spans more than one module
- Needs more than a one-line fix

One-line confirmation from a human is enough to start, but the `plan.md` file must exist in the same work.

## Naming

`initiatives/<kebab-case-slug>/plan.md`

Optional: `deferred.md`, decision notes. Do not store secrets.

Copy [\_template/plan.md](_template/plan.md). Also copy spec and tech-design templates and register them in those indexes.

Folders starting with `_` are templates, not work items.

## Status vocabulary

Use the same words in the phase header and the tracking table:

`not started` · `in progress` · `blocked` · `completed` · `deleted`

## Required companions

Every real initiative plan must link to:

1. A spec under `docs/specs/`
2. A tech design under `docs/tech-design/`

Keep all three in sync when behavior or implementation changes.

## Archival

Do not delete completed folders. Set status `completed` (or `deleted` if abandoned) and leave the tracking table. The index below must still list them.

## Index

| Initiative | Status | Spec | Tech |
| --- | --- | --- | --- |
| [transfer-intent-grounding](transfer-intent-grounding/plan.md) | in progress | [SPEC](../docs/specs/TRANSFER_INTENT_GROUNDING_SPEC.md) | [TECH](../docs/tech-design/TRANSFER_INTENT_GROUNDING_TECH.md) |
| [spend-check-before-send](spend-check-before-send/plan.md) | in progress | [SPEC](../docs/specs/SPEND_CHECK_BEFORE_SEND_SPEC.md) | [TECH](../docs/tech-design/SPEND_CHECK_BEFORE_SEND_TECH.md) |
| [beneficiary-prefill](beneficiary-prefill/plan.md) | completed | [SPEC](../docs/specs/BENEFICIARY_PREFILL_SPEC.md) | [TECH](../docs/tech-design/BENEFICIARY_PREFILL_TECH.md) |
| [bill-payments](bill-payments/plan.md) | completed | [SPEC](../docs/specs/BILL_PAYMENTS_SPEC.md) | [SPIKE](../docs/tech-design/BILL_PAYMENTS_SPIKE.md) |
| [whatsapp-media-and-spend-pushback](whatsapp-media-and-spend-pushback/plan.md) | in progress | [SPEC](../docs/specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md) | [TECH](../docs/tech-design/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_TECH.md) |
| [ai-money-intents](ai-money-intents/plan.md) | in progress | [SPEC](../docs/specs/AI_MONEY_INTENTS_SPEC.md) | [TECH](../docs/tech-design/AI_MONEY_INTENTS_TECH.md) |
| [weekly-review-limit-escape](weekly-review-limit-escape/plan.md) | completed | [SPEC](../docs/specs/WEEKLY_REVIEW_LIMIT_ESCAPE_SPEC.md) | [TECH](../docs/tech-design/WEEKLY_REVIEW_LIMIT_ESCAPE_TECH.md) |
| [production-hardening](production-hardening/plan.md) | completed | [SPEC](../docs/specs/PRODUCTION_HARDENING_SPEC.md) | [TECH](../docs/tech-design/PRODUCTION_HARDENING_TECH.md) |

Update this table whenever you add a folder or change status. `npm run docs:check` enforces registration.
