import { IntentRouterService } from "./intent-router.service";
import { ExtractionValidatorService } from "../ai/extraction-validator.service";
import { LlmCallPurpose } from "@prisma/client";

describe("IntentRouterService", () => {
  let llm: { complete: jest.Mock };
  let llmLogger: { log: jest.Mock; markApplied: jest.Mock };
  let service: IntentRouterService;

  function llmResult(toolCall?: { name: string; arguments: unknown }) {
    return {
      text: toolCall ? undefined : "just chatting back",
      toolCall,
      raw: {},
      latencyMs: 1,
      provider: "stub",
      model: "stub",
    };
  }

  beforeEach(() => {
    llm = { complete: jest.fn() };
    llmLogger = {
      log: jest.fn().mockResolvedValue({ id: "log-1" }),
      markApplied: jest.fn(),
    };
    service = new IntentRouterService(
      llm as any,
      new ExtractionValidatorService(), // real validator, same as other AI-boundary specs
      llmLogger as any,
    );
  });

  it.each([
    "BALANCE",
    "LIMITS",
    "ACCOUNT_DETAILS",
    "TRANSFER",
    "NONE",
  ] as const)(
    "classifies a well-formed %s tool call correctly",
    async (intent) => {
      llm.complete.mockResolvedValue(
        llmResult({
          name: "classify_menu_intent",
          arguments: { intent },
        }),
      );

      const result = await service.classify("some message", "user-1");

      expect(result).toBe(intent);
    },
  );

  it("always requests a forced tool call, never 'auto'", async () => {
    llm.complete.mockResolvedValue(
      llmResult({
        name: "classify_menu_intent",
        arguments: { intent: "BALANCE" },
      }),
    );

    await service.classify("what's my balance", "user-1");

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        forceTool: true,
        purpose: LlmCallPurpose.INTENT_CLASSIFICATION,
        userId: "user-1",
      }),
    );
  });

  it("fails open to NONE when the model doesn't make a tool call", async () => {
    llm.complete.mockResolvedValue(llmResult(undefined));

    const result = await service.classify("hey how's it going", "user-1");

    expect(result).toBe("NONE");
    expect(llmLogger.markApplied).toHaveBeenCalledWith("log-1", null, false);
  });

  it("fails open to NONE when the tool call's intent value is malformed/unknown", async () => {
    llm.complete.mockResolvedValue(
      llmResult({
        name: "classify_menu_intent",
        arguments: { intent: "DEFINITELY_NOT_A_REAL_INTENT" },
      }),
    );

    const result = await service.classify("something weird", "user-1");

    expect(result).toBe("NONE");
  });

  it("fails open to NONE, without throwing, when the LLM call itself errors", async () => {
    llm.complete.mockRejectedValue(new Error("provider down"));

    const result = await service.classify("what's my balance", "user-1");

    expect(result).toBe("NONE");
  });

  it("logs the call via LlmCallLoggerService with the classification purpose", async () => {
    llm.complete.mockResolvedValue(
      llmResult({
        name: "classify_menu_intent",
        arguments: { intent: "TRANSFER" },
      }),
    );

    await service.classify("send my landlord some money", "user-1");

    expect(llmLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        purpose: LlmCallPurpose.INTENT_CLASSIFICATION,
      }),
    );
    expect(llmLogger.markApplied).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ accepted: true, cleanedValue: "TRANSFER" }),
      true,
    );
  });
});
