import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import { EmailStatus, EmailType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { htmlToPlainText } from "./email-plain-text.util";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SendEmailParams {
  userId: string;
  to: string | null;
  type: EmailType;
  subject: string;
  html: string;
  /** Optional plain-text body; generated from html when omitted. */
  text?: string;
  /** Merged into Resend headers after defaults (e.g. List-Unsubscribe). */
  headers?: Record<string, string>;
  /**
   * Idempotency key encoding what this email is *about* — a specific credit,
   * a specific transaction, a specific user-week. A retried webhook or an
   * overlapping scheduler tick collides on EmailLog's unique index rather
   * than sending the user a duplicate.
   */
  dedupeKey: string;
}

export type SendEmailResult =
  | { sent: true; providerId?: string }
  | {
      sent: false;
      reason: "duplicate" | "no_address" | "not_configured" | "error";
    };

/**
 * Resend integration, via their REST API through HttpService rather than the
 * `resend` npm package — consistent with how every other external provider in
 * this codebase is wired (RubiesService, WhatsappService both call REST
 * directly), and it keeps the dependency surface unchanged.
 *
 * Every send is best-effort and NEVER throws into its caller. These emails
 * are notifications about money movement that has already happened; a Resend
 * outage must not fail a transfer, roll back a webhook, or break a scheduler
 * tick. Failures are written to EmailLog with the error text and logged
 * loudly, so a silently-missing email is still diagnosable afterwards. This
 * is the same "best-effort, never block the main flow" pattern used for the
 * override-fee sweep and the typing indicator.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  private get apiKey(): string | undefined {
    return this.config.get<string>("RESEND_API_KEY");
  }

  private get fromAddress(): string {
    return (
      this.config.get<string>("RESEND_FROM_ADDRESS") ??
      "Udara <noreply@useudara.com>"
    );
  }

  /** Reply-To should be a monitored inbox on the same verified domain as From. */
  private get replyToAddress(): string | undefined {
    return this.config.get<string>("RESEND_REPLY_TO") ?? undefined;
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    // Claim the dedupe key first. Writing the log row *before* calling Resend
    // is deliberate: if two ticks race, exactly one wins the unique index and
    // only that one calls the API. Claiming after the send would leave a
    // window where both could deliver.
    let claimed: { id: string } | null = null;
    try {
      claimed = await this.prisma.emailLog.create({
        data: {
          userId: params.userId,
          type: params.type,
          toAddress: params.to ?? "",
          subject: params.subject,
          status: EmailStatus.SKIPPED, // provisional; updated once we know
          dedupeKey: params.dedupeKey,
        },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        this.logger.debug(
          `Email ${params.type} for user ${params.userId} already handled (${params.dedupeKey})`,
        );
        return { sent: false, reason: "duplicate" };
      }
      this.logger.error(`Could not record email log: ${String(err)}`);
      return { sent: false, reason: "error" };
    }

    if (!params.to) {
      this.logger.warn(
        `No email address on file for user ${params.userId} — skipping ${params.type}`,
      );
      await this.finalize(claimed.id, EmailStatus.SKIPPED, {
        error: "no email address on file",
      });
      return { sent: false, reason: "no_address" };
    }

    // Dev-mode escape hatch, same shape as WHATSAPP_KYC_FLOW_ID: an unset key
    // is a legitimate state for a fresh environment. Warn loudly, record the
    // skip, carry on.
    if (!this.apiKey) {
      this.logger.warn(
        `RESEND_API_KEY is not set — skipping ${params.type} email to ${params.to}`,
      );
      await this.finalize(claimed.id, EmailStatus.SKIPPED, {
        error: "RESEND_API_KEY not configured",
      });
      return { sent: false, reason: "not_configured" };
    }

    try {
      const payload: Record<string, unknown> = {
        from: this.fromAddress,
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text ?? htmlToPlainText(params.html),
        tags: [{ name: "email_type", value: params.type.toLowerCase() }],
        headers: {
          "X-Entity-Ref-ID": params.dedupeKey.slice(0, 100),
          ...params.headers,
        },
      };
      const replyTo = this.replyToAddress;
      if (replyTo) {
        payload.reply_to = replyTo;
      }

      const response = await firstValueFrom(
        this.http.post<{ id?: string }>(RESEND_ENDPOINT, payload, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
        }),
      );

      await this.finalize(claimed.id, EmailStatus.SENT, {
        providerId: response.data?.id,
      });
      return { sent: true, providerId: response.data?.id };
    } catch (err) {
      const detail = describeError(err);
      this.logger.error(
        `Resend send failed for user ${params.userId} (${params.type}): ${detail}`,
      );
      await this.finalize(claimed.id, EmailStatus.FAILED, { error: detail });
      return { sent: false, reason: "error" };
    }
  }

  private async finalize(
    id: string,
    status: EmailStatus,
    extra: { providerId?: string; error?: string },
  ): Promise<void> {
    try {
      await this.prisma.emailLog.update({
        where: { id },
        data: { status, ...extra },
      });
    } catch (err) {
      // The email itself already succeeded or failed; a bookkeeping failure
      // here must not propagate.
      this.logger.error(`Could not finalize email log ${id}: ${String(err)}`);
    }
  }
}

/** Surfaces Resend's own error body when present, since it names the cause. */
function describeError(err: unknown): string {
  const response = (err as { response?: { status?: number; data?: unknown } })
    ?.response;
  if (response) {
    return `HTTP ${response.status}: ${JSON.stringify(response.data)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
