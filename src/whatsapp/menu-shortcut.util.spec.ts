import { isMenuShortcut, menuPayloadFromUtterance } from "./menu-shortcut.util";
import { MENU_BALANCE } from "./account-actions.service";

describe("isMenuShortcut", () => {
  it("matches the post-cancel phrasing from production", () => {
    expect(isMenuShortcut("what else can you do?")).toBe(true);
  });

  it("matches help/menu", () => {
    expect(isMenuShortcut("help")).toBe(true);
    expect(isMenuShortcut("Menu")).toBe(true);
  });

  it("matches 'tell me things you can do again'", () => {
    expect(isMenuShortcut("Can you tell me things you can do again?")).toBe(
      true,
    );
  });

  it("does not treat an airtime capability check as a menu ask", () => {
    expect(
      isMenuShortcut("So you can do airtime and bills payments now yea?"),
    ).toBe(false);
  });

  it("does not match transfer or chat", () => {
    expect(isMenuShortcut("what else can you do with my transfer")).toBe(false);
    expect(isMenuShortcut("i want to send 800")).toBe(false);
    expect(isMenuShortcut("what do you mean?")).toBe(false);
  });
});

describe("menuPayloadFromUtterance", () => {
  it("maps a list row title including emoji to the menu payload", () => {
    expect(menuPayloadFromUtterance("💰 Check balance")).toBe(MENU_BALANCE);
  });
});
