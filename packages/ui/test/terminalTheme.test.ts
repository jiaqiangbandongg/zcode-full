import { describe, expect, it } from "vitest";
import type { ITheme } from "@xterm/xterm";
import { restrictInheritedTerminalTheme } from "@/terminal/terminalTheme.js";

describe("terminalTheme", () => {
  it("keeps app-controlled readable colors out of inherited profile colors", () => {
    const inherited = restrictInheritedTerminalTheme({
      background: "#111111",
      foreground: "#eeeeee",
      cursor: "#00ff00",
      cursorAccent: "#111111",
      red: "#ff0000",
      brightBlue: "#3399ff",
    } satisfies ITheme);

    expect(inherited).toEqual({
      red: "#ff0000",
      brightBlue: "#3399ff",
    });
  });

  it("drops inherited theme when it only contains app-controlled surface colors", () => {
    expect(
      restrictInheritedTerminalTheme({
        background: "#111111",
        foreground: "#eeeeee",
        cursor: "#00ff00",
        cursorAccent: "#111111",
      } satisfies ITheme),
    ).toBeUndefined();
  });
});
