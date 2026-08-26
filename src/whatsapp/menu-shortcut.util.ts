/**
 * Tiny exact-ask shortcut so "what else can you do?" never waits on the LLM.
 * Not a language parser — only whole-message matches after light normalize.
 */
export function isMenuShortcut(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  return (
    t === 'help' ||
    t === 'menu' ||
    t === 'options' ||
    t === 'what else can you do' ||
    t === 'what can you do' ||
    t === 'what can you do here' ||
    t === 'what can i do' ||
    t === 'what can i do here' ||
    t === 'what are my options'
  );
}
