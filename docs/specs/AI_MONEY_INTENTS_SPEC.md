# AI money intents

**Status:** Draft  
Initiative: [initiatives/ai-money-intents/plan.md](../../initiatives/ai-money-intents/plan.md)  
Tech design: [../tech-design/AI_MONEY_INTENTS_TECH.md](../tech-design/AI_MONEY_INTENTS_TECH.md)

## Problem

Users can buy airtime/data, pay prepaid electricity, and send to saved people from the menu, but chat does not use those facts. Amount questions sound like a form. Tapping Other does not let them say what the money is for.

## Goals

- Chat can start the matching bill wizard and skip steps the user already stated
- Named or listed saved payees prefill transfers; unknown names do not invent accounts
- Other collects a short typed purpose
- Amounts may be spoken naturally (`5k`, `five thousand`); code parses them

## Non-goals

- Cable TV or other billers
- Model-picked data bundle product codes
- Skipping confirm or PIN
- Fabricating balances, meters, phones, or NUBANs

## User-visible behavior

### Bills in chat

“Buy 2k MTN airtime”, “buy data”, “pay nepa” get the same first-send coaching question as a bank send. After they answer or insist, the **airtime / data / electricity** wizard opens — not send-money. Stated amount, network, phone, DisCo, or meter skip those wizard steps. Data plans stay a tap list. Confirm then PIN unchanged.

### Beneficiaries

Saved nicknames in live facts are ground truth. “Send 5k to james” prefills when the match is unique. Ambiguous names still get a pick list. If they want to send and did not name anyone, they see recent saved payees to pick — never a made-up account. An unknown name continues the normal account/bank wizard.

### Other purpose

After **Other** (or when the purpose is not Rent/Food/Vendor), Udara asks what it is for. That note is stored on the send. Spend summary still buckets Other.

### Amounts

Wizard and chat ask “how much?” without demanding digits. `5k` / `₦5,000` / `five thousand` are valid. If code cannot parse, ask again in ordinary language.

## Edge cases

- “Pay electricity” is a bill, not a bank transfer
- “Send 5k for airtime to …” with a NUBAN is still a transfer
- Empty beneficiary list: ask for account/bank as today
- Window closed: coaching may continue; money path still enforces the window at confirm

## Safety / PII

Purpose notes are short free text (capped). Do not log PIN/BVN/NIN. Catalog codes and meters are applied by wizard code, not trusted from the model.

## Acceptance (observable)

- Chat airtime/data/electricity launches the matching wizard with prefill; confirm + PIN still required
- Bill-shaped “pay …” does not open send-money
- Unique saved name prefills; unknown name has no invented account
- Other then typed purpose appears on the transaction
- Linguistic amounts accepted; copy does not say “just the number”

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-31 | Initial |
