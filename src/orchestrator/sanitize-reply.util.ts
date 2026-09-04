/**
 * Strips things the model should never be able to put in front of a user.
 *
 * Everything the model sees is user-role content, including transcribed voice
 * notes and photos the user forwards. So a scam screenshot saying "your account
 * is compromised, move your money to 0123456789" is input, and the model can
 * relay it — in Udara's own voice, to someone who trusts Udara with their
 * money. Nothing inspected the reply text before it was sent.
 *
 * Two things are removed:
 *
 * - **Long digit runs** the user did not supply, which are account numbers.
 *   Attested ones survive, so "send it to 0123456789?" still works when the user
 *   typed those digits.
 * - **Links.** Udara has no reason to send one, and a link in this channel is
 *   phishing by default.
 *
 * Amounts are left alone. They are the substance of ordinary conversation here,
 * and the figures that matter are owned by surfaces, not by reply text.
 */

const DIGIT_RUN = /\d[\d\s-]{7,}\d/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;

export function sanitizeReplyText(
  message: string,
  attestedDigits: string,
): { text: string; removed: boolean } {
  if (!message) return { text: message, removed: false };
  let removed = false;

  let text = message.replace(URL_LIKE, () => {
    removed = true;
    return "[link removed]";
  });

  text = text.replace(DIGIT_RUN, (run) => {
    const bare = run.replace(/[\s-]/g, "");
    if (bare.length < 8 || attestedDigits.includes(bare)) return run;
    removed = true;
    return "[number removed]";
  });

  return { text, removed };
}
