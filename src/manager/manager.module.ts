import { Module } from "@nestjs/common";
import { ManagerService } from "./manager.service";
import { ManagerConversationService } from "./manager-conversation.service";
import { ManagerScheduler } from "./manager.scheduler";
import { MessagingModule } from "../messaging/messaging.module";
import { AiModule } from "../ai/ai.module";

@Module({
  imports: [AiModule, MessagingModule],
  providers: [ManagerService, ManagerConversationService, ManagerScheduler],
  exports: [ManagerService, ManagerConversationService],
})
export class ManagerModule {}
