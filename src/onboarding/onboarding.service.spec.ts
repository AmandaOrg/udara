import { OnboardingService, isPreAccountStage } from "./onboarding.service";
import {
  BudgetMethod,
  IncomePosture,
  IncomeType,
  OnboardingStage,
} from "@prisma/client";

/**
 * A tiny in-memory fake for the two models OnboardingService touches. Each
 * method under test makes several sequential prisma calls (read extractedData,
 * merge, write; read session, advance stage, write user) — chaining
 * mockResolvedValueOnce in the exact right order would be brittle and
 * unreadable at this size, so this behaves like a real (if minimal) store.
 */
function createFakePrisma(initialUser: Record<string, unknown>) {
  const users = new Map<string, Record<string, unknown>>([
    [initialUser.id as string, { ...initialUser }],
  ]);
  const sessions = new Map<string, Record<string, unknown>>();
  let sessionCounter = 0;

  return {
    user: {
      findUniqueOrThrow: jest.fn(async ({ where: { id } }: any) => {
        const u = users.get(id);
        if (!u) throw new Error(`user ${id} not found`);
        return { ...u };
      }),
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        users.has(id) ? { ...users.get(id) } : null,
      ),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const updated = { ...users.get(id), ...data };
        users.set(id, updated);
        return { ...updated };
      }),
    },
    onboardingSession: {
      findFirst: jest.fn(async ({ where: { userId } }: any) => {
        const found = [...sessions.values()]
          .filter((s) => s.userId === userId)
          .sort(
            (a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime(),
          )[0];
        return found ? { ...found } : null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where: { id } }: any) => {
        const s = sessions.get(id);
        if (!s) throw new Error(`session ${id} not found`);
        return { ...s };
      }),
      create: jest.fn(async ({ data }: any) => {
        sessionCounter += 1;
        const id = `session-${sessionCounter}`;
        const s = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          extractedData: null,
          ...data,
        };
        sessions.set(id, s);
        return { ...s };
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const updated = { ...sessions.get(id), ...data };
        sessions.set(id, updated);
        return { ...updated };
      }),
    },
    _users: users,
    _sessions: sessions,
  };
}

describe("isPreAccountStage", () => {
  it.each([
    OnboardingStage.DISCOVERY,
    OnboardingStage.WELCOME,
    OnboardingStage.IDENTITY,
    OnboardingStage.MONEY_STORY,
    OnboardingStage.AI_REFLECTION,
    OnboardingStage.STRUCTURED_QUESTIONS,
    OnboardingStage.PLAN_PROPOSED,
  ])("%s is pre-account", (stage) => {
    expect(isPreAccountStage(stage)).toBe(true);
  });

  it.each([
    OnboardingStage.ACCOUNT_CREATED,
    OnboardingStage.FUNDED,
    OnboardingStage.FIRST_TRANSACTION,
    OnboardingStage.COMPLETE,
  ])("%s is NOT pre-account", (stage) => {
    expect(isPreAccountStage(stage)).toBe(false);
  });
});

describe("OnboardingService", () => {
  let prisma: ReturnType<typeof createFakePrisma>;
  let llm: { complete: jest.Mock };
  let validator: {
    validateIdentity: jest.Mock;
    validateMoneyStory: jest.Mock;
    validateReflectionContext: jest.Mock;
  };
  let llmLogger: { log: jest.Mock; markApplied: jest.Mock };
  let chunkedMessenger: { sendChunkedReply: jest.Mock };
  let whatsapp: { sendText: jest.Mock; sendListMessage: jest.Mock };
  let rubies: { provisionAccount: jest.Mock };
  let service: OnboardingService;

  function makeUser(overrides: Record<string, unknown> = {}) {
    return {
      id: "user-1",
      whatsappNumber: "234801",
      onboardingStage: OnboardingStage.DISCOVERY,
      name: null,
      occupation: null,
      monthlyIncome: null,
      statedGoal: null,
      city: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    llm = { complete: jest.fn() };
    validator = {
      validateIdentity: jest.fn(),
      validateMoneyStory: jest.fn(),
      validateReflectionContext: jest.fn(),
    };
    llmLogger = {
      log: jest.fn().mockResolvedValue({ id: "log-1" }),
      markApplied: jest.fn(),
    };
    chunkedMessenger = {
      sendChunkedReply: jest.fn().mockResolvedValue(undefined),
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
      sendListMessage: jest.fn().mockResolvedValue({ waMessageId: "wamid.2" }),
    };
    rubies = { provisionAccount: jest.fn() };
  });

  function build(user: Record<string, unknown>) {
    prisma = createFakePrisma(user);
    service = new OnboardingService(
      prisma as any,
      llm as any,
      validator as any,
      llmLogger as any,
      chunkedMessenger as any,
      whatsapp as any,
      rubies as any,
    );
    return prisma._users.get(user.id as string)!;
  }

  describe("DISCOVERY/WELCOME", () => {
    it("sends the fixed welcome+identity-question text and advances straight to IDENTITY, without calling the LLM", async () => {
      build(makeUser({ onboardingStage: OnboardingStage.DISCOVERY }));

      await service.handleInboundText(makeUser() as any, "hi");

      expect(llm.complete).not.toHaveBeenCalled();
      expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("welcome to kedu"),
        "user-1",
      );
      expect(prisma._users.get("user-1")?.onboardingStage).toBe(
        OnboardingStage.IDENTITY,
      );
    });
  });

  describe("IDENTITY", () => {
    it("on accepted extraction: writes name/occupation, advances to MONEY_STORY, sends the money-story questions", async () => {
      build(makeUser({ onboardingStage: OnboardingStage.IDENTITY }));
      llm.complete.mockResolvedValue({
        toolCall: {
          name: "record_identity",
          arguments: { name: "Daniel", occupation: "software engineer" },
        },
        raw: {},
        latencyMs: 1,
        provider: "stub",
        model: "stub",
      });
      validator.validateIdentity.mockReturnValue({
        accepted: true,
        cleanedValue: { name: "Daniel", occupation: "software engineer" },
      });

      await service.handleInboundText(
        makeUser({ onboardingStage: OnboardingStage.IDENTITY }) as any,
        "Daniel, software engineer",
      );

      expect(prisma._users.get("user-1")).toMatchObject({
        name: "Daniel",
        occupation: "software engineer",
        onboardingStage: OnboardingStage.MONEY_STORY,
      });
      expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("nice to meet you, Daniel"),
        "user-1",
      );
    });

    it("on rejected extraction: stays on IDENTITY and sends a nudge, doesn't write anything", async () => {
      build(makeUser({ onboardingStage: OnboardingStage.IDENTITY }));
      llm.complete.mockResolvedValue({
        toolCall: {
          name: "record_identity",
          arguments: { name: "", occupation: "" },
        },
        raw: {},
        latencyMs: 1,
        provider: "stub",
        model: "stub",
      });
      validator.validateIdentity.mockReturnValue({
        accepted: false,
        reason: "name is missing",
      });

      await service.handleInboundText(
        makeUser({ onboardingStage: OnboardingStage.IDENTITY }) as any,
        "huh",
      );

      expect(prisma._users.get("user-1")?.name).toBeNull();
      expect(prisma._users.get("user-1")?.onboardingStage).toBe(
        OnboardingStage.IDENTITY,
      );
      expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("name is missing"),
        "user-1",
      );
    });

    it("on a vague answer (no tool call): sends the model's free-text follow-up, stays on stage", async () => {
      build(makeUser({ onboardingStage: OnboardingStage.IDENTITY }));
      llm.complete.mockResolvedValue({
        text: "what should I call you?",
        raw: {},
        latencyMs: 1,
        provider: "stub",
        model: "stub",
      });

      await service.handleInboundText(
        makeUser({ onboardingStage: OnboardingStage.IDENTITY }) as any,
        "hey",
      );

      expect(validator.validateIdentity).not.toHaveBeenCalled();
      expect(prisma._users.get("user-1")?.onboardingStage).toBe(
        OnboardingStage.IDENTITY,
      );
      expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
        "234801",
        "what should I call you?",
        "user-1",
      );
    });
  });

  describe("MONEY_STORY", () => {
    it("on accepted extraction: writes income/goal, advances to AI_REFLECTION, and immediately triggers the reflection turn", async () => {
      build(
        makeUser({
          onboardingStage: OnboardingStage.MONEY_STORY,
          name: "Daniel",
        }),
      );
      llm.complete
        .mockResolvedValueOnce({
          toolCall: {
            name: "record_money_story",
            arguments: {
              monthlyIncome: 1_500_000,
              statedGoal: "save for a car",
            },
          },
          raw: {},
          latencyMs: 1,
          provider: "stub",
          model: "stub",
        })
        .mockResolvedValueOnce({
          text: "thanks for sharing — how old are you and where are you based?",
          raw: {},
          latencyMs: 1,
          provider: "stub",
          model: "stub",
        });
      validator.validateMoneyStory.mockReturnValue({
        accepted: true,
        cleanedValue: {
          monthlyIncome: 1_500_000,
          statedGoal: "save for a car",
        },
      });

      await service.handleInboundText(
        makeUser({
          onboardingStage: OnboardingStage.MONEY_STORY,
          name: "Daniel",
        }) as any,
        "1.5m, save for a car",
      );

      expect(prisma._users.get("user-1")).toMatchObject({
        monthlyIncome: 1_500_000,
        statedGoal: "save for a car",
        onboardingStage: OnboardingStage.AI_REFLECTION,
      });
      // Two LLM calls: the money-story extraction, then the chained reflection turn.
      expect(llm.complete).toHaveBeenCalledTimes(2);
      expect(chunkedMessenger.sendChunkedReply).toHaveBeenLastCalledWith(
        "234801",
        "thanks for sharing — how old are you and where are you based?",
        "user-1",
      );
    });
  });

  describe("AI_REFLECTION", () => {
    it("on accepted extraction: writes city, advances to STRUCTURED_QUESTIONS, sends the first list question", async () => {
      build(makeUser({ onboardingStage: OnboardingStage.AI_REFLECTION }));
      llm.complete.mockResolvedValue({
        toolCall: {
          name: "record_reflection_context",
          arguments: { city: "Abuja", age: 26 },
        },
        raw: {},
        latencyMs: 1,
        provider: "stub",
        model: "stub",
      });
      validator.validateReflectionContext.mockReturnValue({
        accepted: true,
        cleanedValue: { city: "Abuja", age: 26 },
      });

      await service.handleInboundText(
        makeUser({ onboardingStage: OnboardingStage.AI_REFLECTION }) as any,
        "26, Abuja",
      );

      expect(prisma._users.get("user-1")).toMatchObject({
        city: "Abuja",
        onboardingStage: OnboardingStage.STRUCTURED_QUESTIONS,
      });
      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
        expect.any(String),
        expect.any(Array),
        "user-1",
      );
    });
  });

  describe("STRUCTURED_QUESTIONS (buttons)", () => {
    it("routes a stray text message to a gentle nudge instead of the AI", async () => {
      build(
        makeUser({ onboardingStage: OnboardingStage.STRUCTURED_QUESTIONS }),
      );
      await service.handleInboundText(
        makeUser({
          onboardingStage: OnboardingStage.STRUCTURED_QUESTIONS,
        }) as any,
        "I don't earn enough",
      );
      expect(llm.complete).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("tap one of the options"),
        "user-1",
      );
    });

    it("records sq1, advances to sq2 (not the last question)", async () => {
      const user = build(
        makeUser({ onboardingStage: OnboardingStage.STRUCTURED_QUESTIONS }),
      );
      await service.handleInboundButton(user as any, "sq1:earn_struggle");

      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        "What are your biggest impulse spending areas?",
        expect.any(String),
        expect.any(Array),
        "user-1",
      );
    });

    it("re-sends the current question on an unrecognized button id", async () => {
      const user = build(
        makeUser({ onboardingStage: OnboardingStage.STRUCTURED_QUESTIONS }),
      );
      await service.handleInboundButton(user as any, "sq1:not-a-real-option");

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("doesn't match"),
        "user-1",
      );
      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        "Which statement describes you best?",
        expect.any(String),
        expect.any(Array),
        "user-1",
      );
    });

    it("on the last question: computes and writes the plan, advances to PLAN_PROPOSED, presents the plan + trust moment", async () => {
      const user = build(
        makeUser({
          onboardingStage: OnboardingStage.STRUCTURED_QUESTIONS,
          monthlyIncome: 1_500_000,
          occupation: "software engineer",
          name: "Daniel",
        }),
      );

      await service.handleInboundButton(user as any, "sq1:earn_struggle");
      await service.handleInboundButton(user as any, "sq2:food");
      await service.handleInboundButton(user as any, "sq3:weekly");
      await service.handleInboundButton(user as any, "sq4:strict");

      const finalUser = prisma._users.get("user-1")!;
      expect(finalUser.onboardingStage).toBe(OnboardingStage.PLAN_PROPOSED);
      expect(finalUser.incomeType).toBe(IncomeType.SALARIED); // occupation "software engineer" -> SALARIED heuristic
      expect(finalUser.incomePosture).toBe(IncomePosture.RESTRICT); // sq1 != "no_earn"
      expect(finalUser.budgetMethod).toBe(BudgetMethod.FLAT);
      expect(finalUser.strictnessLevel).toBe(4); // sq4:strict
      // 1.5M * 20% = 300k monthly -> 10k/day -> matches the script's own worked example.
      expect(finalUser.flatDailyAmount).toBe(10_000);

      const calls = chunkedMessenger.sendChunkedReply.mock.calls.map(
        (c: any[]) => c[1],
      );
      expect(calls.some((t: string) => t.includes("₦10,000"))).toBe(true);
      expect(calls.some((t: string) => t.includes("bvn"))).toBe(true);
    });

    it("uses GROW posture and PERCENTAGE budgeting for a founder who says they don't earn enough", async () => {
      const user = build(
        makeUser({
          onboardingStage: OnboardingStage.STRUCTURED_QUESTIONS,
          monthlyIncome: 200_000,
          occupation: "startup founder",
          name: "Amaka",
        }),
      );

      await service.handleInboundButton(user as any, "sq1:no_earn");
      await service.handleInboundButton(user as any, "sq2:other");
      await service.handleInboundButton(user as any, "sq3:daily");
      await service.handleInboundButton(user as any, "sq4:remind");

      const finalUser = prisma._users.get("user-1")!;
      expect(finalUser.incomeType).toBe(IncomeType.FOUNDER);
      expect(finalUser.incomePosture).toBe(IncomePosture.GROW);
      expect(finalUser.budgetMethod).toBe(BudgetMethod.PERCENTAGE);
      expect(finalUser.budgetPercentage).toBe(0.2);
      expect(finalUser.flatDailyAmount).toBeNull();
      expect(finalUser.strictnessLevel).toBe(1); // sq4:remind
    });
  });

  describe("PLAN_PROPOSED (Trust Moment)", () => {
    it("collects BVN/email/DOB incrementally across turns and asks for what's still missing", async () => {
      const user = build(
        makeUser({ onboardingStage: OnboardingStage.PLAN_PROPOSED }),
      );

      await service.handleInboundText(user as any, "my bvn is 12345678901");
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        expect.stringContaining("your email"),
        "user-1",
      );

      await service.handleInboundText(user as any, "me@example.com");
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        expect.stringContaining("date of birth"),
        "user-1",
      );
      expect(rubies.provisionAccount).not.toHaveBeenCalled();
    });

    it("provisions the Rubies account once BVN+email+DOB are all present, in one message", async () => {
      const user = build(
        makeUser({
          onboardingStage: OnboardingStage.PLAN_PROPOSED,
          name: "Daniel Okafor",
          whatsappNumber: "234801",
        }),
      );
      rubies.provisionAccount.mockResolvedValue({
        accountId: "CUST-1",
        accountNumber: "0123456789",
        accountName: "Daniel Okafor",
        bankCode: "090175",
      });

      await service.handleInboundText(
        user as any,
        "12345678901, me@example.com, 1998-04-12",
      );

      expect(rubies.provisionAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          bvn: "12345678901",
          firstName: "Daniel",
          lastName: "Okafor",
          dob: "1998-04-12",
          email: "me@example.com",
        }),
      );
      const finalUser = prisma._users.get("user-1")!;
      expect(finalUser.rubiesAccountNumber).toBe("0123456789");
      expect(finalUser.onboardingStage).toBe(OnboardingStage.ACCOUNT_CREATED);
      expect(finalUser.bvn).toBeUndefined(); // never written to the User record
      expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("0123456789"),
        "user-1",
      );
    });

    it("on a Rubies failure: stays on PLAN_PROPOSED, clears bvn/dob (not email) so the retry isn't stuck on stale bad data", async () => {
      const user = build(
        makeUser({
          onboardingStage: OnboardingStage.PLAN_PROPOSED,
          name: "Daniel",
        }),
      );
      rubies.provisionAccount.mockRejectedValue(
        new Error("First name does not match"),
      );

      await service.handleInboundText(
        user as any,
        "12345678901, me@example.com, 1998-04-12",
      );

      expect(prisma._users.get("user-1")?.onboardingStage).toBe(
        OnboardingStage.PLAN_PROPOSED,
      );
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("First name does not match"),
        "user-1",
      );

      // Resending BVN/DOB (not email) should be enough to retry.
      rubies.provisionAccount.mockResolvedValue({
        accountId: "CUST-1",
        accountNumber: "0123456789",
        accountName: "Daniel",
        bankCode: "090175",
      });
      await service.handleInboundText(user as any, "12345678901, 1998-04-12");
      expect(rubies.provisionAccount).toHaveBeenCalledTimes(2);
    });
  });

  describe("handleInboundButton outside STRUCTURED_QUESTIONS", () => {
    it("replies that the button doesn't apply", async () => {
      const user = build(
        makeUser({ onboardingStage: OnboardingStage.IDENTITY }),
      );
      await service.handleInboundButton(user as any, "sq1:earn_struggle");
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("doesn't apply"),
        "user-1",
      );
    });
  });
});
