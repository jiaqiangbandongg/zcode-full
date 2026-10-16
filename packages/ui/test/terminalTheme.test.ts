import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ITheme } from "@xterm/xterm";
import { restrictInheritedTerminalTheme } from "@/terminal/terminalTheme.js";

function readCssBlock(selector: string): string {
  const styles = readFileSync("packages/ui/src/styles.css", "utf8");
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? "";
}

function readCssToken(block: string, token: string): string | undefined {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`${escapedToken}:\\s*([^;]+);`))?.[1]?.trim();
}

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

  it("keeps Zai Light terminal surface colors bound to app theme tokens", () => {
    const zaiLightBlock = readCssBlock(".theme-zai-light");

    expect(readCssToken(zaiLightBlock, "--color-terminal-bg")).toBe("var(--color-background)");
    expect(readCssToken(zaiLightBlock, "--color-terminal-fg")).toBe("var(--color-foreground)");
    expect(readCssToken(zaiLightBlock, "--color-terminal-cursor")).toBe("#0d0d0d");
    expect(readCssToken(zaiLightBlock, "--color-terminal-cursor-accent")).toBe(
      "var(--color-background)",
    );
  });
});
