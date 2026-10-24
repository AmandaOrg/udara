/**
 * Shows enough of the address to confirm which inbox to check, without
 * printing it in full: into a chat someone holding the phone can read, an API
 * response, or a log line.
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "your email";
  const shown = local.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;
}
