import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("appearance settings layout", () => {
  it("代码设置和代码预览上下排列，亮暗预览仅在宽屏左右排列", () => {
    const source = readFileSync("packages/ui/src/settingsCodePreview.tsx", "utf8");

    expect(source).toContain('className="space-y-6"');
    expect(source).toContain('className="grid gap-4 sm:grid-cols-2"');
    expect(source).not.toContain('className="grid gap-4 lg:grid-cols-2"');
    expect(source).not.toContain('className="grid gap-4 xl:grid-cols-2"');
    expect(source).not.toContain('className="grid gap-4 2xl:grid-cols-2"');
    expect(source).not.toContain('className="grid items-start gap-6 xl:grid-cols-2"');
    expect(source).toContain('id: "settings.appearance.codeTitle"');
    expect(source).toContain('id: "settings.previewSectionTitle"');
  });

  it("把实时预览统一命名为代码预览", () => {
    expect(zhCN["settings.uiFontSize"]).toBe("界面字号");
    expect(zhCN["settings.appearance.interfaceTitle"]).toBe("界面设置");
    expect(zhCN["settings.appearance.codeTitle"]).toBe("代码设置");
    expect(zhCN["settings.previewSectionTitle"]).toBe("代码预览");
    expect(enUS["settings.appearance.interfaceTitle"]).toBe("Interface Setting");
    expect(enUS["settings.appearance.codeTitle"]).toBe("Code settings");
    expect(enUS["settings.previewSectionTitle"]).toBe("Code preview");
  });

  it("语言选项除系统默认外使用对应语言自名", () => {
    // Bugfix: 固定语言项表示目标语言本身，不能随当前 UI locale 翻译成另一种写法。
    expect(zhCN["settings.locale.system"]).toBe("系统默认");
    expect(enUS["settings.locale.system"]).toBe("System default");
    expect(zhCN["settings.locale.zh-CN"]).toBe("中文简体");
    expect(enUS["settings.locale.zh-CN"]).toBe("中文简体");
    expect(zhCN["settings.locale.en-US"]).toBe("English");
    expect(enUS["settings.locale.en-US"]).toBe("English");
  });

  it("文案描述可见效果，不再声称修改 rem 布局或显示右侧单一预览", () => {
    expect(zhCN["settings.appearance.interfaceDescription"]).toBe(
      "设置应用主题和界面文字大小。",
    );
    expect(zhCN["settings.uiFontSizeDescription"]).toContain("图标和布局尺寸不受影响");
    expect(zhCN["settings.previewDescription"]).toContain("同时预览浅色与深色代码主题");
    expect(enUS["settings.uiFontSizeDescription"]).toContain(
      "without changing icons or layout dimensions",
    );
    expect(enUS["settings.previewDescription"]).toContain(
      "Preview the light and dark code themes together",
    );

    for (const copy of [
      zhCN["settings.appearance.interfaceDescription"],
      zhCN["settings.uiFontSizeDescription"],
      zhCN["settings.previewDescription"],
      enUS["settings.appearance.interfaceDescription"],
      enUS["settings.uiFontSizeDescription"],
      enUS["settings.previewDescription"],
    ]) {
      expect(copy.toLowerCase()).not.toContain("rem");
      expect(copy).not.toContain("右侧");
      expect(copy.toLowerCase()).not.toContain("on the right");
    }
  });
});
