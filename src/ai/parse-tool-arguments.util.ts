/**
 * Tool-call `arguments` from OpenAI-compatible providers is usually a JSON
 * string. Truncated output (max_tokens) makes JSON.parse throw — that used
 * to fail the whole orchestrator turn with no retry.
 */
export function parseToolCallArguments(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
