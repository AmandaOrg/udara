import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { Response } from "express";
import { Sentry } from "./sentry";

/**
 * Reports unhandled errors with their stack, and to Sentry when configured.
 *
 * Every catch block in this codebase formats errors as `String(err)`, which for
 * an Error gives "Error: message" and throws the stack away — so a production
 * failure left a one-line log entry and no way to find the code that produced
 * it. This filter is the backstop for anything that reaches the framework.
 *
 * Expected HttpExceptions (a rejected webhook signature, a validation failure)
 * are left alone: they are the system working, not a fault to page on.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("UnhandledException");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;

    if (status >= 500) {
      this.logger.error(
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception),
      );
      Sentry.captureException(exception);
    }

    // The path may already be resolved — webhook controllers ack before doing
    // their work, so by the time something throws the response is often sent.
    if (response.headersSent) return;
    response.status(status).json({
      statusCode: status,
      message:
        exception instanceof HttpException
          ? exception.message
          : "Internal server error",
    });
  }
}
