import { isMenuShortcut } from "./menu-shortcut.util";

describe("isMenuShortcut", () => {
  it("matches the post-cancel phrasing from production", () => {
    expect(isMenuShortcut("what else can you do?")).toBe(true);
  });

  it("matches help/menu", () => {
    expect(isMenuShortcut("help")).toBe(true);
    expect(isMenuShortcut("Menu")).toBe(true);
  });

  it("does not match transfer or chat", () => {
    expect(isMenuShortcut("what else can you do with my transfer")).toBe(false);
    expect(isMenuShortcut("i want to send 800")).toBe(false);
    expect(isMenuShortcut("what do you mean?")).toBe(false);
  });
});
