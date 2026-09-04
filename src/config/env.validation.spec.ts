// class-transformer/class-validator read design-time type metadata, which only
// exists once the reflect-metadata polyfill is loaded. Nest does this in main.ts;
// a bare unit test has to do it itself.
import "reflect-metadata";
import { validate } from "./env.validation";

/**
 * The webhook signing secrets are the one place where a *blank* value is more
 * dangerous than a missing service: both signature guards fall back to accepting
 * unverified requests, so a deployed environment missing one variable silently
 * becomes an open endpoint that anyone can drive as any phone number, or use to
 * fabricate an incoming credit.
 *
 * These tests pin the fail-closed contract: the escape hatch has to be asked for.
 */
describe("validate — webhook signing secrets", () => {
  const base = {
    DATABASE_URL: "postgresql://kedu:kedu@localhost:5433/kedu?schema=public",
    DAILY_WINDOW_START_HOUR: "11",
    DAILY_WINDOW_END_HOUR: "20",
    EARLY_ACCESS_FLAT_FEE: "1000",
    EARLY_ACCESS_PERCENT_FEE: "0.002",
    BORROW_FLAT_FEE: "1000",
    BORROW_PERCENT_FEE: "0.004",
    SETTINGS_CHANGE_MIN_DAYS: "7",
    PORT: "3000",
  };

  it("boots when both signing secrets are set", () => {
    expect(() =>
      validate({
        ...base,
        WHATSAPP_APP_SECRET: "meta-app-secret",
        RUBIES_SECRET_KEY: "whsec-rubies",
      }),
    ).not.toThrow();
  });

  it.each([
    ["WHATSAPP_APP_SECRET", { RUBIES_SECRET_KEY: "whsec-rubies" }],
    ["RUBIES_SECRET_KEY", { WHATSAPP_APP_SECRET: "meta-app-secret" }],
  ])("refuses to boot when %s is absent", (missing, present) => {
    expect(() => validate({ ...base, ...present })).toThrow(missing);
  });

  it.each(["", "   "])(
    "treats a blank value (%p) as absent, not as configured",
    (blank) => {
      expect(() =>
        validate({
          ...base,
          WHATSAPP_APP_SECRET: blank,
          RUBIES_SECRET_KEY: "whsec-rubies",
        }),
      ).toThrow("WHATSAPP_APP_SECRET");
    },
  );

  it("names every missing secret at once, not just the first", () => {
    expect(() => validate({ ...base })).toThrow(
      /WHATSAPP_APP_SECRET[\s\S]*RUBIES_SECRET_KEY/,
    );
  });

  it("points the reader at the opt-out rather than just failing", () => {
    expect(() => validate({ ...base })).toThrow(/ALLOW_UNSIGNED_WEBHOOKS=true/);
  });

  it("allows both to be blank when the opt-out is explicit (local and e2e)", () => {
    expect(() =>
      validate({ ...base, ALLOW_UNSIGNED_WEBHOOKS: "true" }),
    ).not.toThrow();
  });

  it.each(["false", "1", "yes", "TRUE", ""])(
    "does not accept %p as an opt-out — only the exact string 'true'",
    (value) => {
      expect(() =>
        validate({ ...base, ALLOW_UNSIGNED_WEBHOOKS: value }),
      ).toThrow("WHATSAPP_APP_SECRET");
    },
  );

  it("still enforces the ordinary structural checks first", () => {
    expect(() =>
      validate({ ...base, DATABASE_URL: "not-a-postgres-url" }),
    ).toThrow("DATABASE_URL");
  });
});
