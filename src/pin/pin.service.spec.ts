import { PinService } from "./pin.service";
import { PinChallengePurpose } from "@prisma/client";

describe("PinService", () => {
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    pinChallenge: {
      create: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let service: PinService;

  const userId = "user-1";

  function makeUser(overrides: Record<string, unknown> = {}) {
    return {
      id: userId,
      pinHash: null,
      pinSetAt: null,
      pinFailedAttempts: 0,
      pinLockedUntil: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(async ({ data }: any) => makeUser(data)),
      },
      pinChallenge: {
        create: jest.fn(async ({ data }: any) => ({ id: "c1", ...data })),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new PinService(prisma as any);
  });

  /** Sets a PIN and returns the hash that was written, for verification tests. */
  async function setAndCaptureHash(pin: string): Promise<string> {
    prisma.user.update.mockClear();
    const result = await service.setPin(userId, pin, pin);
    expect(result.ok).toBe(true);
    return prisma.user.update.mock.calls[0][0].data.pinHash as string;
  }

  describe("PIN strength rules", () => {
    it.each(["123", "12345", "abcd", "12a4", ""])(
      "rejects %p as not four digits",
      (pin) => {
        expect(service.validatePinStrength(pin)).toMatchObject({ ok: false });
      },
    );

    it("rejects a mismatched confirmation", () => {
      const result = service.validatePinStrength("8317", "8318");
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("didn't match");
    });

    it.each(["0000", "1111", "7777"])("rejects repeated digits %p", (pin) => {
      expect(service.validatePinStrength(pin)).toMatchObject({ ok: false });
    });

    it.each(["1234", "4321", "3456", "6543"])(
      "rejects sequential digits %p",
      (pin) => {
        expect(service.validatePinStrength(pin)).toMatchObject({ ok: false });
      },
    );

    it("rejects a common-PIN denylist entry that is neither repeated nor sequential", () => {
      // 2580 is the middle column of a keypad — passes the structural rules,
      // caught only by the denylist.
      expect(service.validatePinStrength("2580")).toMatchObject({ ok: false });
    });

    it.each(["8317", "5092", "7413"])("accepts a strong PIN %p", (pin) => {
      expect(service.validatePinStrength(pin)).toEqual({ ok: true });
    });
  });

  describe("hashing", () => {
    it("never stores the PIN itself", async () => {
      const hash = await setAndCaptureHash("8317");
      expect(hash).not.toContain("8317");
      expect(hash.startsWith("scrypt$")).toBe(true);
    });

    it("produces a different hash each time, so identical PINs aren't linkable", async () => {
      const a = await setAndCaptureHash("8317");
      const b = await setAndCaptureHash("8317");
      expect(a).not.toEqual(b);
    });

    it("accepts the correct PIN against its own hash", async () => {
      const pinHash = await setAndCaptureHash("8317");
      prisma.user.findUniqueOrThrow.mockResolvedValue(makeUser({ pinHash }));

      await expect(service.verifyPin(userId, "8317")).resolves.toEqual({
        ok: true,
      });
    });

    it("rejects a wrong PIN against a real hash", async () => {
      const pinHash = await setAndCaptureHash("8317");
      prisma.user.findUniqueOrThrow.mockResolvedValue(makeUser({ pinHash }));

      const result = await service.verifyPin(userId, "8318");
      expect(result.ok).toBe(false);
    });

    it("fails closed on a corrupt stored hash rather than letting anyone through", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ pinHash: "not-a-valid-hash" }),
      );
      await expect(service.verifyPin(userId, "8317")).resolves.toMatchObject({
        ok: false,
      });
    });

    it("refuses verification when no PIN has been set", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(makeUser());
      const result = await service.verifyPin(userId, "8317");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("haven't set a pin");
    });
  });

  describe("lockout", () => {
    const now = new Date("2026-01-08T12:00:00Z");

    async function failOnce(attemptsBefore: number, pinHash: string) {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ pinHash, pinFailedAttempts: attemptsBefore }),
      );
      prisma.user.update.mockImplementation(async ({ data }: any) =>
        makeUser({
          pinHash,
          pinFailedAttempts:
            data.pinFailedAttempts?.increment !== undefined
              ? attemptsBefore + 1
              : attemptsBefore,
        }),
      );
      return service.verifyPin(userId, "0001", now);
    }

    it("counts a failure atomically via increment, not a read-then-write", async () => {
      const pinHash = await setAndCaptureHash("8317");
      await failOnce(0, pinHash);

      const incrementCall = prisma.user.update.mock.calls.find(
        (c: any[]) => c[0].data?.pinFailedAttempts?.increment === 1,
      );
      expect(incrementCall).toBeDefined();
    });

    it("does not lock before the third failure, and says how many tries remain", async () => {
      const pinHash = await setAndCaptureHash("8317");
      const result = await failOnce(0, pinHash);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.lockedUntil).toBeUndefined();
        expect(result.reason).toContain("2 tries left");
      }
    });

    it("locks for 15 minutes on the third consecutive failure", async () => {
      const pinHash = await setAndCaptureHash("8317");
      const result = await failOnce(2, pinHash);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.lockedUntil).toEqual(new Date("2026-01-08T12:15:00Z"));
      }
    });

    it("escalates to an hour on the sixth, and a day on the ninth", async () => {
      const pinHash = await setAndCaptureHash("8317");

      const sixth = await failOnce(5, pinHash);
      if (!sixth.ok) {
        expect(sixth.lockedUntil).toEqual(new Date("2026-01-08T13:00:00Z"));
      }

      const ninth = await failOnce(8, pinHash);
      if (!ninth.ok) {
        expect(ninth.lockedUntil).toEqual(new Date("2026-01-09T12:00:00Z"));
      }
    });

    it("refuses to verify at all while locked, without consuming an attempt", async () => {
      const pinHash = await setAndCaptureHash("8317");
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({
          pinHash,
          pinFailedAttempts: 3,
          pinLockedUntil: new Date("2026-01-08T12:15:00Z"),
        }),
      );
      prisma.user.update.mockClear();

      // Correct PIN, but locked — still refused.
      const result = await service.verifyPin(userId, "8317", now);
      expect(result.ok).toBe(false);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("lets the user back in once the lock has expired", async () => {
      const pinHash = await setAndCaptureHash("8317");
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({
          pinHash,
          pinFailedAttempts: 3,
          pinLockedUntil: new Date("2026-01-08T11:59:00Z"), // already passed
        }),
      );
      await expect(service.verifyPin(userId, "8317", now)).resolves.toEqual({
        ok: true,
      });
    });

    it("resets the failure counter on a successful verification", async () => {
      const pinHash = await setAndCaptureHash("8317");
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ pinHash, pinFailedAttempts: 2 }),
      );
      prisma.user.update.mockClear();

      await service.verifyPin(userId, "8317", now);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { pinFailedAttempts: 0, pinLockedUntil: null },
        }),
      );
    });

    it("clears lockout state when a new PIN is set", async () => {
      prisma.user.update.mockClear();
      await service.setPin(userId, "8317", "8317");
      expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      });
    });
  });

  describe("single-use challenges", () => {
    const now = new Date("2026-01-08T12:00:00Z");

    function challenge(overrides: Record<string, unknown> = {}) {
      return {
        id: "c1",
        userId,
        flowToken: "tok",
        purpose: PinChallengePurpose.TRANSFER_AUTH,
        transactionId: "txn-1",
        expiresAt: new Date("2026-01-08T12:05:00Z"),
        consumedAt: null,
        ...overrides,
      };
    }

    it("consumes a valid challenge and marks it used", async () => {
      prisma.pinChallenge.findUnique.mockResolvedValue(challenge());

      const result = await service.consumeChallenge("tok", userId, now);

      expect(result).toMatchObject({ transactionId: "txn-1" });
      expect(prisma.pinChallenge.updateMany).toHaveBeenCalledWith({
        where: { id: "c1", consumedAt: null },
        data: { consumedAt: now },
      });
    });

    it("rejects an unknown token", async () => {
      prisma.pinChallenge.findUnique.mockResolvedValue(null);
      await expect(
        service.consumeChallenge("nope", userId, now),
      ).resolves.toBeNull();
    });

    it("rejects an expired token", async () => {
      prisma.pinChallenge.findUnique.mockResolvedValue(
        challenge({ expiresAt: new Date("2026-01-08T11:59:00Z") }),
      );
      await expect(
        service.consumeChallenge("tok", userId, now),
      ).resolves.toBeNull();
    });

    it("rejects a replayed token", async () => {
      prisma.pinChallenge.findUnique.mockResolvedValue(
        challenge({ consumedAt: new Date("2026-01-08T12:01:00Z") }),
      );
      await expect(
        service.consumeChallenge("tok", userId, now),
      ).resolves.toBeNull();
      expect(prisma.pinChallenge.updateMany).not.toHaveBeenCalled();
    });

    it("rejects another user's token", async () => {
      prisma.pinChallenge.findUnique.mockResolvedValue(
        challenge({ userId: "someone-else" }),
      );
      await expect(
        service.consumeChallenge("tok", userId, now),
      ).resolves.toBeNull();
      expect(prisma.pinChallenge.updateMany).not.toHaveBeenCalled();
    });

    it("loses a concurrent race rather than letting both replies through", async () => {
      prisma.pinChallenge.findUnique.mockResolvedValue(challenge());
      // The other request consumed it between our read and our write.
      prisma.pinChallenge.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.consumeChallenge("tok", userId, now),
      ).resolves.toBeNull();
    });

    it("issues a fresh token per challenge with a 5-minute default expiry", async () => {
      await service.createChallenge({
        userId,
        purpose: PinChallengePurpose.TRANSFER_AUTH,
        transactionId: "txn-1",
        now,
      });
      const { data } = prisma.pinChallenge.create.mock.calls[0][0];
      expect(data.flowToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(data.expiresAt).toEqual(new Date("2026-01-08T12:05:00Z"));
    });
  });
});
