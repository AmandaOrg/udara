import type { INestApplication } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

/**
 * The OpenAPI document and UI for the app API, at /docs and /docs-json, for
 * building the app against locally. Off unless APP_API_DOCS=true.
 *
 * These routes are mounted straight on Express, outside v1 and so outside
 * AppAuthGuard: anyone who can reach the server can read them. They describe
 * routes and grant nothing, but they are still a map of the API, which is why
 * they are opt-in and must never be switched on in a deployed environment.
 */
export function mountApiDocs(app: INestApplication): boolean {
  if (
    process.env.APP_API_ENABLED?.trim() !== "true" ||
    process.env.APP_API_DOCS?.trim() !== "true"
  ) {
    return false;
  }
  const config = new DocumentBuilder()
    .setTitle("Udara app API")
    .setVersion("1")
    .addBearerAuth()
    .addSecurityRequirements("bearer")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config));
  new Logger("ApiDocs").warn(
    "APP_API_DOCS=true: the API description is served at /docs. Never set this in a deployed environment.",
  );
  return true;
}
