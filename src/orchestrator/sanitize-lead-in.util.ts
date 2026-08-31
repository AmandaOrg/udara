/**
 * Lead-in copy from the LLM, before a deterministic surface.
 */
export function collapseToSingleBubble(text: string): string {
  return text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeSurfaceLeadIn(
  text: string,
  surfaceKey?: string,
): string {
  const collapsed = collapseToSingleBubble(text);
  if (!collapsed) return "";

  const readOrMenuSurface =
    surfaceKey === "balance_read" ||
    surfaceKey === "limits_read" ||
    surfaceKey === "account_details" ||
    surfaceKey === "spend_summary" ||
    surfaceKey === "spending_menu";

  // Those surfaces send the real reply (or the capability list). LLM lead-in
  // is how "hey still here" showed up before a tapped Check balance.
  if (readOrMenuSurface) {
    return "";
  }

  if (collapsed.length > 160) {
    return collapsed.slice(0, 157).trimEnd() + "…";
  }
  return collapsed;
}
