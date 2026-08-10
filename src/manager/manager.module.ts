import { forwardRef, Module } from "@nestjs/common";
import { ManagerService } from "./manager.service";
import { ManagerConversationService } from "./manager-conversation.service";
import { ManagerScheduler } from "./manager.scheduler";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { AiModule } from "../ai/ai.module";

@Module({
  // forwardRef: WhatsappModule already imports ManagerModule, and
  // ManagerConversationService needs WhatsappService back (to actually send the
  // acknowledgment/delayed-reply/decision messages) — same circular pattern as
  // RubiesModule, resolved the same way.
  imports: [AiModule, forwardRef(() => WhatsappModule)],
  providers: [ManagerService, ManagerConversationService, ManagerScheduler],
  exports: [ManagerService, ManagerConversationService],
})
export class ManagerModule {}
