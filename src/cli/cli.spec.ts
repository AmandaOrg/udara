import { FixtureLlmService } from "./fixture-llm.service";
import { LlmCallPurpose } from "@prisma/client";
import { formatTurnPretty, formatTurnJson } from "./print-executor";
import { runGoldenCase, loadGoldenDialogues } from "./golden-runner";
import { ActionValidatorService } from "../orchestrator/action-validator.service";

describe("FixtureLlmService", () => {
  it("returns a forced propose_turn tool call from the loaded fixture", async () => {
    const llm = new FixtureLlmService();
    llm.setFixture({
      message: "pulling that up",
      action: {
        type: "show_surface",
        surface_key: "balance_read",
        confidence: "high",
      },
    });

    const result = await llm.complete({
      messages: [{ role: "user", content: "balance" }],
      tool: {
        name: "propose_turn",
        description: "x",
        schema: {},
      },
      forceTool: true,
      purpose: LlmCallPurpose.ORCHESTRATOR_TURN,
    });

    expect(result.provider).toBe("fixture");
    expect(result.toolCall?.name).toBe("propose_turn");
    expect(result.toolCall?.arguments).toEqual({
      message: "pulling that up",
      action: {
        type: "show_surface",
        surface_key: "balance_read",
        confidence: "high",
      },
    });
  });

  it("throws when no fixture is loaded", async () => {
    const llm = new FixtureLlmService();
    await expect(
      llm.complete({
        messages: [],
        purpose: LlmCallPurpose.ORCHESTRATOR_TURN,
      }),
    ).rejects.toThrow(/no fixture/);
  });
});

describe("print-executor", () => {
  it("formats failure SOP clearly", () => {
    const text = formatTurnPretty({ message: "", ok: false });
    expect(text).toContain("ok:           false");
    expect(text).toContain("spending_menu");
  });

  it("formats success with surface and hints as JSON", () => {
    const json = JSON.parse(
      formatTurnJson({
        message: "lets go",
        surfaceKey: "transfer_wizard",
        extractedHints: { amount: 5000 },
        ok: true,
      }),
    );
    expect(json).toEqual({
      ok: true,
      message: "lets go",
      surfaceKey: "transfer_wizard",
      extractedHints: { amount: 5000 },
    });
  });
});

describe("golden-runner", () => {
  it("matches the golden fixture's expected surface (first send is spend-check)", () => {
    const cases = loadGoldenDialogues();
    const firstSend = cases.find((c) => c.test_case_id === "tx_intent_01");
    expect(firstSend).toBeDefined();
    const paused = runGoldenCase(new ActionValidatorService(), firstSend!);
    expect(paused.passed).toBe(true);
    expect(paused.actual_surface).toBeNull();

    const proceed = cases.find(
      (c) => c.test_case_id === "spend_check_proceed_launches_wizard",
    );
    expect(proceed).toBeDefined();
    const launched = runGoldenCase(new ActionValidatorService(), proceed!);
    expect(launched.passed).toBe(true);
    expect(launched.actual_surface).toBe("transfer_wizard");
  });
});
