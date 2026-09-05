# Decision records

Cross-cutting choices that are expensive to rediscover. Feature execution stays in `initiatives/`. Product rules stay in `docs/specs/`. Implementation how stays in `docs/tech-design/`.

## When to write an ADR

- Choosing or changing a default (LLM vs deterministic path, provider, data store).
- A constraint that future agents must not “simplify away”.
- Rejecting an obvious alternative.

Skip an ADR for a one-file bugfix. Link the ADR from the initiative plan when both exist.

## Status values

`proposed` · `accepted` · `superseded` · `deprecated`

## Index

| ID | Title | Status |
| --- | --- | --- |
| [0001](0001-settings-request-surface.md) | Let the model file a settings-change request | accepted |

## New record

Copy [_template.md](_template.md) to `NNNN-short-title.md` (4-digit, increment). Add a row to the table above.
