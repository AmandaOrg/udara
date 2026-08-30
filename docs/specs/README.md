# Specs

Stakeholder-visible behavior for a feature. **What** happens and **why**, not class names or SQL.

## Rules

- One spec per initiative that changes user-visible behavior.
- No Nest module wiring, env var catalogs, or Prisma field lists — those belong in [../tech-design/](../tech-design/README.md).
- Cross-link the initiative plan and tech design at the top.
- When behavior changes after freeze, amend this file in the same PR (dated changelog).
- If the original PRD is still missing, say so and mark rules as verified-from-code.

## Index

| Spec | Initiative |
| --- | --- |
| [TRANSFER_INTENT_GROUNDING_SPEC.md](TRANSFER_INTENT_GROUNDING_SPEC.md) | [transfer-intent-grounding](../../initiatives/transfer-intent-grounding/plan.md) |
| [SPEND_CHECK_BEFORE_SEND_SPEC.md](SPEND_CHECK_BEFORE_SEND_SPEC.md) | [spend-check-before-send](../../initiatives/spend-check-before-send/plan.md) |
| [BENEFICIARY_PREFILL_SPEC.md](BENEFICIARY_PREFILL_SPEC.md) | [beneficiary-prefill](../../initiatives/beneficiary-prefill/plan.md) |
| [BILL_PAYMENTS_SPEC.md](BILL_PAYMENTS_SPEC.md) | [bill-payments](../../initiatives/bill-payments/plan.md) |
| [WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md](WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md) | [whatsapp-media-and-spend-pushback](../../initiatives/whatsapp-media-and-spend-pushback/plan.md) |

## New spec

Copy [_template.md](_template.md). Register the file in this table and in [../../initiatives/README.md](../../initiatives/README.md).
