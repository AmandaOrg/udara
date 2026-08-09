import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  // rawBody: true preserves the raw request bytes alongside the parsed JSON body —
  // required for webhook signature verification (WhatsApp's X-Hub-Signature-256,
  // Rubies' X-Webhook-Signature), since HMAC has to run over the exact bytes sent,
  // not a re-serialized version of the parsed object.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Kedu is running on port ${port}`);
}
bootstrap();
