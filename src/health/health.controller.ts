import { Controller, Get, Logger } from "@nestjs/common";
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from "@nestjs/terminus";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The only non-webhook route in the app.
 *
 * Railway had no way to tell a booted process from a working one: with no health
 * endpoint, a container that came up but could not reach Postgres stayed in the
 * rotation, and every inbound WhatsApp message it received was acked and then
 * silently dropped. The restart policy could not help because nothing was
 * crashing.
 *
 * Deliberately unauthenticated and free of detail — it reports reachability, not
 * versions, counts, or configuration.
 */
@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.checkDatabase()]);
  }

  /**
   * A trivial round-trip rather than `$connect`, which succeeds against a pool
   * that has no usable connection left.
   */
  private async checkDatabase(): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { database: { status: "up" } };
    } catch (err) {
      // The reason goes to the log stream, not the response body. Prisma's
      // connection errors name the database host and port, and this route is
      // unauthenticated — the caller only needs to know it is down.
      this.logger.error(
        `health check failed: ${err instanceof Error ? err.stack : String(err)}`,
      );
      return { database: { status: "down" } };
    }
  }
}
