import { BankDirectoryService } from "./bank-directory.service";

const BANKS = [
  { bankCode: "000004", bankName: "GTBank" },
  { bankCode: "000005", bankName: "Access Bank" },
];

describe("BankDirectoryService", () => {
  it("caches the list, sorted by name, for six hours", async () => {
    const rubies = { listBanks: jest.fn().mockResolvedValue(BANKS) };
    const directory = new BankDirectoryService(rubies as any);

    const first = await directory.list(0);
    await directory.list(5 * 60 * 60_000);

    expect(first.map((b) => b.bankName)).toEqual(["Access Bank", "GTBank"]);
    expect(rubies.listBanks).toHaveBeenCalledTimes(1);

    await directory.list(6 * 60 * 60_000 + 1);
    expect(rubies.listBanks).toHaveBeenCalledTimes(2);
  });

  it("makes one Rubies call for concurrent misses", async () => {
    let release!: (banks: typeof BANKS) => void;
    const rubies = {
      listBanks: jest.fn(
        () => new Promise<typeof BANKS>((resolve) => (release = resolve)),
      ),
    };
    const directory = new BankDirectoryService(rubies as any);

    const calls = [directory.list(0), directory.list(0), directory.list(0)];
    release(BANKS);
    const results = await Promise.all(calls);

    expect(rubies.listBanks).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.length === 2)).toBe(true);
  });

  it("does not keep an empty answer, and does not ask again for a minute", async () => {
    const rubies = {
      listBanks: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(BANKS),
    };
    const directory = new BankDirectoryService(rubies as any);

    expect(await directory.list(0)).toEqual([]);
    expect(await directory.list(30_000)).toEqual([]);
    expect(rubies.listBanks).toHaveBeenCalledTimes(1);

    expect(await directory.list(61_000)).toHaveLength(2);
    expect(rubies.listBanks).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good list while Rubies is down", async () => {
    const rubies = {
      listBanks: jest.fn().mockResolvedValueOnce(BANKS).mockResolvedValue([]),
    };
    const directory = new BankDirectoryService(rubies as any);

    await directory.list(0);
    const later = await directory.list(7 * 60 * 60_000);

    expect(later).toHaveLength(2);
    expect(await directory.names()).toEqual(
      new Map([
        ["000005", "Access Bank"],
        ["000004", "GTBank"],
      ]),
    );
  });
});
