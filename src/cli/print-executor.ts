/**
 * Print-only "executor" for CLI dry-run — never sends WhatsApp or touches money.
 */

import { OrchestratorResult } from "../orchestrator/orchestrator.types";

export function formatTurnPretty(result: OrchestratorResult): string {
  if (result.ok === false) {
    return [
      "── turn result ──────────────────────────────",
      "ok:           false (failure SOP)",
      'would send:   "here\'s everything you can do with me."',
      "would launch: spending_menu",
      "─────────────────────────────────────────────",
      "Hint: stub LLM emits no tool calls. Use --fixture <json> or set AI_PROVIDER to a real provider.",
    ].join("\n");
  }

  const lines = [
    "── turn result ──────────────────────────────",
    `ok:           true`,
    `message:      ${JSON.stringify(result.message)}`,
    `surface:      ${result.surfaceKey ?? "(reply_only — no UI)"}`,
  ];
  if (result.extractedHints && Object.keys(result.extractedHints).length > 0) {
    lines.push(`hints:        ${JSON.stringify(result.extractedHints)}`);
  }
  lines.push("─────────────────────────────────────────────");
  return lines.join("\n");
}

export function formatTurnJson(result: OrchestratorResult): string {
  return JSON.stringify(
    {
      ok: result.ok !== false,
      message:
        result.ok === false
          ? "here's everything you can do with me."
          : result.message,
      surfaceKey:
        result.ok === false ? "spending_menu" : (result.surfaceKey ?? null),
      extractedHints:
        result.ok === false ? null : (result.extractedHints ?? null),
    },
    null,
    2,
  );
}

export function printTurn(result: OrchestratorResult, asJson: boolean) {
  // eslint-disable-next-line no-console
  console.log(asJson ? formatTurnJson(result) : formatTurnPretty(result));
}
