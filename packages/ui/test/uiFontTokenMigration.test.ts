import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(path, "utf8");

describe("UI font token migration", () => {
  it("maps legacy 13px UI text to text-ui-base", () => {
    const tokenSpec = readSource("docs/ui/ui-font-tokens.md");
    const remoteFields = readSource("packages/ui/src/RemoteConnectionFields.tsx");
    const automationEditor = readSource(
      "packages/ui/src/settings/AutomationEditView.tsx",
    );
    const conversationRows = readSource("packages/ui/src/v4/ConversationRowView.tsx");

    expect(tokenSpec).toContain("Replace legacy explicit 13px UI text with `text-ui-base`");
    expect(tokenSpec).not.toContain(
      "Normalize arbitrary 10px through 13px UI text to `text-ui-xs`",
    );
    expect(remoteFields).toContain('className="h-9 text-ui-base"');
    // Bug 原因：调度选择器已收敛为共享的 SelectItem 样式，旧断言仍绑定被删除的 trigger class。
    expect(automationEditor).toContain(
      '"min-h-8 rounded-[8px] px-2 py-1.5 pr-8 text-ui-base leading-5',
    );
    // 附件 pill 重构为 FileDisplayInline 后，13px 文案 token 锚点迁移到
    // fileNameClassName；源码可能跨行，这里只断言 token 组合本身仍在文件里。
    expect(conversationRows).toContain(
      '"truncate text-ui-base font-medium text-foreground"',
    );
  });

  it("uses the base token for the time-of-day picker controls", () => {
    const automationEditor = readSource(
      "packages/ui/src/settings/AutomationEditView.tsx",
    );

    expect(automationEditor).toContain(
      '"rounded-md px-2 py-1 text-center text-ui-base tabular-nums transition-colors"',
    );
    expect(automationEditor).toContain(
      'pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground',
    );
  });

  it("does not hard-code an 18px line height on scalable UI copy", () => {
    const scalableUiSources = [
      readSource("packages/ui/src/settings/AutomationsSection.tsx"),
      readSource("packages/ui/src/settings/AutomationEditView.tsx"),
      readSource("packages/ui/src/settings/AutomationDesignPrimitives.tsx"),
      readSource("packages/ui/src/settings/OffPeakEditView.tsx"),
      readSource("packages/ui/src/settings/OffPeakHistoryTab.tsx"),
      readSource("packages/ui/src/settings/OffPeakTaskList.tsx"),
      readSource("packages/ui/src/v4/OffPeakNewTaskEntry.tsx"),
      readSource("packages/ui/src/components/ui/toast.tsx"),
    ];

    for (const source of scalableUiSources) {
      expect(source).not.toContain("leading-[18px]");
    }
  });
});
