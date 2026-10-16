import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  detectLocale,
  getZCodeCopy,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
  type ZCodeCopy,
} from "../src/index.js";

describe("i18n catalog", () => {
  it("resolves supported, auto, and unknown locale values deterministically", () => {
    expect(DEFAULT_LOCALE).toBe("en-US");
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("auto", "zh_Hans_CN")).toBe("zh-CN");
    expect(resolveLocale("auto", "en-GB")).toBe("en-US");
    expect(resolveLocale("fr-FR")).toBe("en-US");
    expect(getZCodeCopy("auto", "zh_CN.UTF-8").locale).toBe("zh-CN");
  });

  it("detects supported locales from adapter-provided OS hints", () => {
    expect(detectLocale({ env: { LC_ALL: "zh_CN.UTF-8" } })).toBe("zh-CN");
    expect(detectLocale({ env: { LC_ALL: "C.UTF-8", LC_MESSAGES: "en_GB.UTF-8" } })).toBe("en-US");
    expect(detectLocale({ env: { LANG: "fr_FR.UTF-8" }, intlLocale: "zh-Hans-CN" })).toBe("zh-CN");
    expect(detectLocale({ env: { LANGUAGE: "fr:zh_CN:en_US" } })).toBe("zh-CN");
    expect(detectLocale({ env: { LANG: "POSIX" }, intlLocale: "fr-FR" })).toBeUndefined();
  });

  it("validates UI locale config strings", () => {
    expect(isUiLocale("auto")).toBe(true);
    expect(isUiLocale("en-US")).toBe(true);
    expect(isUiLocale("zh-CN")).toBe(true);
    expect(isUiLocale("fr-FR")).toBe(false);
  });

  it("keeps all locale catalogs shape-compatible", () => {
    const [firstLocale, ...rest] = SUPPORTED_LOCALES;
    const baseShape = catalogShape(getZCodeCopy(firstLocale));

    for (const locale of rest) {
      expect(catalogShape(getZCodeCopy(locale))).toEqual(baseShape);
    }
  });

  it("returns localized TUI and CLI copy", () => {
    const copy = getZCodeCopy("zh-CN");

    expect(copy.tui.status.ready).toBe("就绪。");
    expect(copy.tui.sidebar.sections.status).toBe("状态");
    expect(copy.tui.sidebar.sections.modifiedFiles).toBe("变更文件");
    expect(copy.tui.loginRequired.message).toContain("没有可用模型");
    expect(copy.tui.loginSetup.title).toBe("配置 Coding Plan");
    expect(copy.tui.loginSetup.pending.help).toContain("Esc");
    expect(copy.tui.loginSetup.input.placeholder).toBe("粘贴 API key");
    expect(copy.tui.input.placeholder).toBe("输入提示词");
    expect(copy.cli.help("1.0.0")).toContain("用法:");
  });
});

function catalogShape(value: unknown): unknown {
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return value.map(catalogShape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        catalogShape(item),
      ]),
    );
  }
  return typeof value;
}

void ({} satisfies Partial<ZCodeCopy>);
