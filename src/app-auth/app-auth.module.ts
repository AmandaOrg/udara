import { forwardRef, Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { PinModule } from "../pin/pin.module";
import { MessagingModule } from "../messaging/messaging.module";
import { EmailModule } from "../email/email.module";
import { AppAuthConfig } from "./app-auth.config";
import { SmsService } from "./sms.service";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { LoginService } from "./login.service";
import { LoginApprovalService } from "./login-approval.service";

/**
 * Mobile app sign-in: codes, sessions, step-up. No routes; those live in
 * AppApiModule, which is only loaded when the app API is switched on. This
 * module is always loaded because the WhatsApp router answers sign-in
 * approvals whether or not the API is exposed.
 */
@Module({
  imports: [
    HttpModule.register({ timeout: 15_000, maxRedirects: 0 }),
    PinModule,
    MessagingModule,
    // EmailModule and AllowanceModule import each other; forwardRef keeps this
    // module's load order out of that.
    forwardRef(() => EmailModule),
  ],
  providers: [
    AppAuthConfig,
    SmsService,
    OtpService,
    SessionService,
    LoginService,
    LoginApprovalService,
  ],
  exports: [OtpService, SessionService, LoginService, LoginApprovalService],
})
export class AppAuthModule {}
