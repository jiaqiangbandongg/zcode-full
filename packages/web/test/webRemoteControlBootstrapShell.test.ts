import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

function readWebIndexHtml(): string {
  return readFileSync(resolve(process.cwd(), "packages/web/index.html"), "utf8");
}

function readWorkspaceFile(path: string): Buffer {
  return readFileSync(resolve(process.cwd(), path));
}

function readWorkspaceFileDataUrl(path: string, mimeType: string): string {
  return `data:${mimeType};base64,${readWorkspaceFile(path).toString("base64")}`;
}

function createBootstrapDocument(theme: "zai-dark" | "zai-light"): JSDOM {
  return new JSDOM(readWebIndexHtml(), {
    beforeParse(window) {
      window.localStorage.setItem("zcode-theme", theme);
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: false }),
      });
    },
    runScripts: "dangerously",
    url: "https://zcode.example/remote",
  });
}

describe("web remote control bootstrap shell", () => {
  it("内嵌与桌面 App 同源的浏览器标签图标", () => {
    const html = readWebIndexHtml();
    const document = new JSDOM(html).window.document;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/png"]');

    expect(icon?.href).toBe(readWorkspaceFileDataUrl("public/logo/icons/32x32.png", "image/png"));
    expect(icon?.getAttribute("sizes")).toBe("32x32");
    expect(readWorkspaceFile("packages/web/public/favicon.ico")).toEqual(
      readWorkspaceFile("packages/desktop/build/icon.ico"),
    );
    expect(readWorkspaceFile("public/logo/icons/icon.ico")).toEqual(
      readWorkspaceFile("packages/desktop/build/icon.ico"),
    );
  });

  it.each([
    ["zai-dark", "dark", "#161616"],
    ["zai-light", "light", "#f8f8f8"],
  ] as const)(
    "在业务 bundle 执行前把 %s 同步到浏览器主题表面",
    (storedTheme, resolvedTheme, expectedColor) => {
      const dom = createBootstrapDocument(storedTheme);
      const { document } = dom.window;

      expect(document.documentElement.getAttribute("data-zcode-browser-theme-surface")).toBe(
        resolvedTheme,
      );
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
        expectedColor,
      );
      expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
        resolvedTheme,
      );

      dom.window.close();
    },
  );
});
