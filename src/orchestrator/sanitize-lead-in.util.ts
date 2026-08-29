/**
 * Lead-in copy from the LLM, before a deterministic surface.
 * One bubble, no invented ₦ figures (the surface owns those).
 */
const NAIRA_OR_LONG_NUMBER = /₦[\d,]+(?:\.\d+)?|\b\d{3,}\b/;

export function collapseToSingleBubble(text: string): string {
  return text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeSurfaceLeadIn(
  text: string,
  surfaceKey?: string,
): string {
  const collapsed = collapseToSingleBubble(text);
  if (!collapsed) return "";

  const readSurface =
    surfaceKey === "balance_read" ||
    surfaceKey === "limits_read" ||
    surfaceKey === "account_details" ||
    surfaceKey === "spend_summary";

  if (readSurface && NAIRA_OR_LONG_NUMBER.test(collapsed)) {
    return "pulling that up now.";
  }

  if (collapsed.length > 160) {
    return collapsed.slice(0, 157).trimEnd() + "…";
  }
  return collapsed;
}
