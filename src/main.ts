import { NestFactory } from "@nestjs/core";
import { LogLevel, Logger, ValidationPipe } from "@nestjs/common";
import { initSentry } from "./common/sentry";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { AppModule } from "./app.module";

const ALL_LOG_LEVELS: LogLevel[] = ["error", "warn", "log", "debug", "verbose"];

/**
 * Nest's default logger enables every level, including `debug` and `verbose`.
 * That is the wrong default for a process that handles PINs and identity
 * documents: any debug line a contributor adds while chasing a bug ships
 * straight to the production log sink. Default to the three levels that carry
 * operational signal, and require an explicit LOG_LEVEL to widen it.
 *
 * LOG_LEVEL names the *most verbose* level to emit, ordered as above, so
 * LOG_LEVEL=debug yields error+warn+log+debug.
 */
function resolveLogLevels(): LogLevel[] {
  const requested = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  const index = ALL_LOG_LEVELS.indexOf(requested as LogLevel);
  if (index === -1) return ["error", "warn", "log"];
  return ALL_LOG_LEVELS.slice(0, index + 1);
}

async function bootstrap() {
  // Before Nest, so instrumentation is in place for the first request.
  const sentryEnabled = initSentry();

  // rawBody: true preserves the raw request bytes alongside the parsed JSON body —
  // required for webhook signature verification (WhatsApp's X-Hub-Signature-256,
  // Rubies' X-Webhook-Signature), since HMAC has to run over the exact bytes sent,
  // not a re-serialized version of the parsed object.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: resolveLogLevels(),
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  // Without this, PrismaService.onModuleDestroy never runs: Railway sends
  // SIGTERM on every deploy and the process would drop its connections mid-flight
  // instead of draining them.
  app.enableShutdownHooks();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  const logger = new Logger("Bootstrap");
  logger.log(`Udara is running on port ${port}`);
  if (!sentryEnabled) {
    logger.warn(
      "SENTRY_DSN is not set — unhandled errors will only reach the log stream.",
    );
  }
}

bootstrap().catch((err) => {
  // A rejected bootstrap used to become an unhandled rejection with no message,
  // so a bad env var looked like a silent crash loop on Railway.
  new Logger("Bootstrap").error(
    `Failed to start: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(1);
});
