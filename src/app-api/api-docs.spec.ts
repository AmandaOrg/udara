import { SwaggerModule } from "@nestjs/swagger";
import { mountApiDocs } from "./api-docs";

describe("mountApiDocs", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  it.each([
    [undefined, undefined],
    ["true", undefined],
    ["true", "false"],
    [undefined, "true"],
  ])(
    "serves nothing unless both flags are on (APP_API_ENABLED=%p, APP_API_DOCS=%p)",
    (enabled, docs) => {
      delete process.env.APP_API_ENABLED;
      delete process.env.APP_API_DOCS;
      if (enabled !== undefined) process.env.APP_API_ENABLED = enabled;
      if (docs !== undefined) process.env.APP_API_DOCS = docs;
      const setup = jest.spyOn(SwaggerModule, "setup");

      expect(mountApiDocs({} as any)).toBe(false);
      expect(setup).not.toHaveBeenCalled();
    },
  );

  it("mounts /docs when both are on", () => {
    process.env.APP_API_ENABLED = "true";
    process.env.APP_API_DOCS = "true";
    jest.spyOn(SwaggerModule, "createDocument").mockReturnValue({} as any);
    const setup = jest
      .spyOn(SwaggerModule, "setup")
      .mockImplementation(() => undefined);

    expect(mountApiDocs({} as any)).toBe(true);
    expect(setup).toHaveBeenCalledWith("docs", {}, {});
  });
});
