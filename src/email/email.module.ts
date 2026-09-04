import { forwardRef, Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { EmailService } from "./email.service";
import { EmailNotificationsService } from "./email-notifications.service";
import { EmailScheduler } from "./email.scheduler";
import { AllowanceModule } from "../allowance/allowance.module";

@Module({
  // forwardRef: AllowanceModule pulls in WhatsappModule, which pulls in the
  // services that in turn send these emails — same circular pattern already
  // used between Whatsapp/Allowance/Rubies, resolved the same way.
  imports: [
    // Axios defaults to no timeout at all, so a hung Resend socket would block
    // the caller until the OS gave up on the TCP connection.
    HttpModule.register({ timeout: 30_000, maxRedirects: 5 }),
    forwardRef(() => AllowanceModule),
  ],
  providers: [EmailService, EmailNotificationsService, EmailScheduler],
  exports: [EmailService, EmailNotificationsService],
})
export class EmailModule {}
