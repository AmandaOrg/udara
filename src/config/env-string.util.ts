/** Strip wrapping quotes some hosts leave on env values (`AI_PROVIDER="gemini"`). */
export function normalizeEnvString(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/^['"]+|['"]+$/g, "");
}
