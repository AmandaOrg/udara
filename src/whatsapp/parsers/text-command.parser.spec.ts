import { SettingsChangeType } from "@prisma/client";
import {
  isSpendSummaryQuery,
  parseManagerCommand,
  parseTransferCommand,
} from "./text-command.parser";

describe("parseTransferCommand", () => {
  it("parses a well-formed command", () => {
    expect(parseTransferCommand("send 5000 to 0123456789 000005")).toEqual({
      amount: 5000,
      accountNumber: "0123456789",
      bankCode: "000005",
    });
  });

  it("strips comma thousands-separators from the amount", () => {
    expect(parseTransferCommand("send 25,000 to 0123456789 000005")).toEqual({
      amount: 25000,
      accountNumber: "0123456789",
      bankCode: "000005",
    });
  });

  it("accepts decimal amounts", () => {
    expect(
      parseTransferCommand("send 500.50 to 0123456789 000005")?.amount,
    ).toBe(500.5);
  });

  it("is case-insensitive on 'send'/'to'", () => {
    expect(
      parseTransferCommand("SEND 100 TO 0123456789 000005"),
    ).not.toBeNull();
  });

  it.each([
    "send abc to 0123456789 000005", // non-numeric amount
    "send 0 to 0123456789 000005", // zero amount
    "send -50 to 0123456789 000005", // negative amount
    "send 5000 to 12345 000005", // account number not 10 digits
    "send 5000 to 0123456789 5", // bank code not 6 digits
    "send 5000 0123456789 000005", // missing "to"
    "just a normal message",
    "",
  ])("rejects malformed input: %p", (input) => {
    expect(parseTransferCommand(input)).toBeNull();
  });
});

describe("parseManagerCommand", () => {
  it("parses a well-formed command", () => {
    expect(
      parseManagerCommand("manager EXIT_RESTRICTIONS I want more flexibility"),
    ).toEqual({
      type: SettingsChangeType.EXIT_RESTRICTIONS,
      requestedChange: "I want more flexibility",
    });
  });

  it("is case-insensitive on both the keyword and the type", () => {
    expect(parseManagerCommand("MANAGER window_hours move it earlier")).toEqual(
      {
        type: SettingsChangeType.WINDOW_HOURS,
        requestedChange: "move it earlier",
      },
    );
  });

  it("rejects an unrecognized settings-change type", () => {
    expect(parseManagerCommand("manager DELETE_ACCOUNT please")).toBeNull();
  });

  it("rejects a command with no reason text", () => {
    expect(parseManagerCommand("manager EXIT_RESTRICTIONS")).toBeNull();
  });

  it("rejects non-manager text", () => {
    expect(parseManagerCommand("hello there")).toBeNull();
  });
});

describe("isSpendSummaryQuery", () => {
  it.each([
    "summary",
    "what did I spend this week",
    "spending report please",
    "SPENT too much",
  ])("matches %p", (text) => {
    expect(isSpendSummaryQuery(text)).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(isSpendSummaryQuery("hello there")).toBe(false);
  });
});
