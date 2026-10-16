import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlInitialTheme } from "@web/webRemoteControlThemeSeed.js";

describe("resolveWebRemoteControlInitialTheme", () => {
  it("uses the QR theme only when mobile localStorage has no theme", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: null,
        qrTheme: "zai-dark",
      }),
    ).toBe("zai-dark");
  });

  it("keeps the mobile local theme once the phone has chosen one", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: "light",
        qrTheme: "zai-dark",
      }),
    ).toBe("zai-light");
  });

  it("treats removed theme values as invalid", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: null,
        qrTheme: "legacy-dark",
      }),
    ).toBe("zai-dark");
  });

  it("falls back to the web default when neither side provides a valid theme", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: "midnight",
        qrTheme: undefined,
      }),
    ).toBe("zai-dark");
  });

  it("allows the share page to default to light without overriding an explicit theme", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: "midnight",
        qrTheme: undefined,
        defaultTheme: "zai-light",
      }),
    ).toBe("zai-light");
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: "zai-dark",
        qrTheme: undefined,
        defaultTheme: "zai-light",
      }),
    ).toBe("zai-dark");
  });
});
