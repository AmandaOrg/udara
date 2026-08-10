import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ManagerConversationService } from "./manager-conversation.service";

/**
 * The other half of the deliberate delay (PRD §7): fileChangeRequest sends
 * an immediate plain acknowledgment and stamps initialReplyDueAt a few hours
 * out; this job polls for requests whose due time has passed and sends the
 * actual substantive reply then. Runs every minute — cheap at this app's
 * scale (a handful of pending requests at most) and means "a few hours"
 * lands close to on time rather than off by up to a poll interval.
 */
@Injectable()
export class ManagerScheduler {
  private readonly logger = new Logger(ManagerScheduler.name);

  constructor(
    private readonly managerConversation: ManagerConversationService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sendDueInitialReplies() {
    const due = await this.managerConversation.findDueInitialReplies();
    if (due.length === 0) return;

    this.logger.log(
      `Sending ${due.length} due Manager initial repl${due.length === 1 ? "y" : "ies"}`,
    );
    for (const request of due) {
      try {
        await this.managerConversation.sendInitialReply(request.id);
      } catch (err) {
        this.logger.error(
          `Failed to send initial reply for request ${request.id}: ${String(err)}`,
        );
      }
    }
  }
}
