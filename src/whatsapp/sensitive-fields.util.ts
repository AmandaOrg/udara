/**
 * Redaction at the persistence boundary.
 *
 * Every inbound WhatsApp message is written to the database by
 * WhatsappMessageService.recordInboundIfNew *before* WhatsappRouterService
 * ever sees it (WhatsappController persists, then routes). That ordering
 * means no handler, however careful, can stop a secret from being stored —
 * by the time a handler runs, the row already exists. Sending a secret
 * through a WhatsApp Flow instead of a chat message does not help either:
 * Flow replies land in `flowResponseJson` and `rawPayload` exactly the same
 * way.
 *
 * This is not hypothetical. Before this module existed, BVN/NIN values
 * submitted through the KYC Flow were being persisted in both columns,
 * despite a comment in OnboardingService asserting the raw ID number "only
 * ever exists in memory for this one call" — true of that service, but the
 * message row had already been written.
 *
 * So redaction has to happen here, at the one choke point everything passes
 * through. Callers that genuinely need a plaintext value (PinService
 * verifying a submitted PIN) receive it in memory via the `sensitive` map
 * that recordInboundIfNew returns, which is never persisted and never
 * logged.
 *
 * Mirrors the recursive shape of `redact()` in ai/llm-call-logger.service.ts
 * deliberately: same traversal, same sentinel, so there is one redaction
 * idiom in the codebase rather than two subtly different ones.
 */

export const REDACTED = "[redacted]";

/**
 * Field names that must never reach the database. These are the `name`
 * values used by the WhatsApp Flow JSON definitions in docs/whatsapp-flows/,
 * so adding a sensitive field to a Flow means adding its name here too.
 */
export const SENSITIVE_FLOW_FIELDS = [
  "pin",
  "pin_confirm",
  "otp",
  "new_pin",
  "current_pin",
  "id_number",
  "date_of_birth",
] as const;

const SENSITIVE_SET = new Set<string>(SENSITIVE_FLOW_FIELDS);

/**
 * Deep-redacts any sensitive key, at any depth, in objects and arrays alike.
 * Returns a new structure; the input is never mutated (callers still hold the
 * original in memory and rely on it being intact).
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_SET.has(key) ? REDACTED : redactSensitive(val);
    }
    return out;
  }
  return value;
}

/**
 * The raw webhook payload nests the Flow's answers as a JSON-encoded *string*
 * (`interactive.nfm_reply.response_json`), so a structural key-delete walks
 * straight past them — the value is inside a string, not an object. This
 * re-encodes that string with its sensitive keys redacted, leaving the rest
 * of the payload untouched.
 *
 * This is exactly why the historical leak showed a higher count in
 * `rawPayload` than in `flowResponseJson`: the structural redaction that
 * would have covered one missed the other entirely.
 */
export function redactRawPayload(payload: unknown): unknown {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (SENSITIVE_SET.has(key)) {
          out[key] = REDACTED;
        } else if (key === "response_json" && typeof val === "string") {
          out[key] = redactJsonString(val);
        } else {
          out[key] = walk(val);
        }
      }
      return out;
    }
    return value;
  };
  return walk(payload);
}

/**
 * Redacts inside a JSON-encoded string, preserving it as a string. A payload
 * whose response_json is malformed is replaced wholesale rather than passed
 * through: if it cannot be parsed it cannot be selectively redacted, and
 * storing an unparseable blob that might contain a PIN is the one outcome
 * worth avoiding outright.
 */
function redactJsonString(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(redactSensitive(parsed));
  } catch {
    return REDACTED;
  }
}

/**
 * Pulls the plaintext sensitive values out of a parsed Flow response so they
 * can be handed to the verifying service in memory. Returns only keys that
 * are actually present, so callers can distinguish "not submitted" from
 * "submitted empty".
 */
export function extractSensitive(
  responseJson: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of SENSITIVE_FLOW_FIELDS) {
    const value = responseJson[field];
    if (typeof value === "string" && value.length > 0) out[field] = value;
  }
  return out;
}
