import * as Sentry from "@sentry/node";

/**
 * Error reporting, off unless SENTRY_DSN is set.
 *
 * Before this, a failed fee sweep, a stuck reconciliation, or an unhandled
 * error in a scheduler went to `logger.error` on a log stream nobody watches,
 * and every handler formatted errors with `String(err)`, which discards the
 * stack. For a service that moves money that is not observability, it is hope.
 *
 * Must be called before the Nest app is created so instrumentation is in place
 * for the first request.
 */
export function initSentry(): boolean {
  const dsn = (process.env.SENTRY_DSN ?? "").trim();
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    // Errors only by default. Traces on a WhatsApp bot would be mostly webhook
    // noise, and the sampling cost is not worth it until someone asks for it.
    tracesSampleRate: 0,
    // This process handles PINs, BVN/NIN and dates of birth. Sending request
    // bodies or headers to a third party is exactly the leak the S13 log rule
    // exists to prevent, so the same rule applies here.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
      }
      return event;
    },
  });
  return true;
}

export { Sentry };
