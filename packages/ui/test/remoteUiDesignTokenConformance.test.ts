import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * R3-ISSUE-018：远程 UI 的原型像素值不能绕过设计系统直接进入组件 class。
 * 只扫描本次远程 UI 入口，避免把历史遗留组件的迁移工作混入本 issue。
 * continuity panel 的 var token、已登记的响应式断点和动画 opacity 不属于本规则。
 */
const remoteUiSources = [
  "../src/RemoteConnectionDialogContent.tsx",
  "../src/lib/remoteConnectionPresentation.ts",
  "../src/remote-connection/RemoteConnectionTags.tsx",
  "../src/remote-connection/RemoteConnectionStateIcon.tsx",
  "../src/WorkspaceSidebar/RemoteProjectConnectionDetails.tsx",
  "../src/SettingsPage.tsx",
  "../src/remote-connection/RemoteConnectionConnectingStep.tsx",
  "../src/remote-connection/RemoteLinkRail.tsx",
  "../src/RemoteConnectionFields.tsx",
  "../src/remote-connection/RemotePasswordInput.tsx",
  "../src/project-sidebar/WorkspaceDragOverlay.tsx",
  "../src/WorkspaceSidebar/WorkspacePurposeSection.tsx",
  "../src/RemoteConnectionWizardChrome.tsx",
  "../src/remote-connection/RemoteConnectionSelection.tsx",
  "../src/remote-connection/RemoteConnectionHistoryInput.tsx",
  "../src/remote-connection-flow/ui/RemoteConnectionProgress.tsx",
  "../src/remote-connection/RemoteConnectionNavigationDot.tsx",
  "../src/remote-connection/EditConnectionProfileDialog.tsx",
  "../src/settings/SourceServerManagementPanel.tsx",
  "../src/settings/SourceServerUpdateActivity.tsx",
  "../src/WorkspaceSidebar/RemoteProjectDetailsPopover.tsx",
  "../src/project-sidebar/RemoteProjectMenu.tsx",
] as const;

const forbiddenPatterns = [
  /\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b/u,
  /\btext-\[\d+(?:\.\d+)?(?:px|rem)\]/u,
  /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+/u,
  /\b(?:bg|text|border)-\[(?:#|rgba?\(|hsla?\()/u,
  /\bsize-(?:2\.5|4\.5|7|9)\b/u,
  /\brounded(?:\s|["'])/u,
  /\brounded-\[\d+(?:\.\d+)?(?:px|rem)\]/u,
  /\bsize-\[\d+(?:\.\d+)?(?:px|rem)\]/u,
  /\b(?:min|max)-[wh]-\[\d+(?:\.\d+)?(?:px|rem)\]/u,
  /\b(?:border|bg|text)-(?:success|warning|destructive|foreground-subtle|popover)\/\d+\b/u,
] as const;

describe("remote UI design token conformance", () => {
  it("preserves the responsive settings heading size through scalable semantic tokens", async () => {
    const [source, styles] = await Promise.all([
      readFile(new URL("../src/SettingsPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    ]);
    const headingClass = source.match(/<h2 className="([^"]+)">\s*\{activeSectionLabel\}/u)?.[1];

    expect(headingClass?.split(/\s+/u)).toEqual(
      expect.arrayContaining(["text-ui-settings-title", "lg:text-ui-settings-title-lg"]),
    );
    // 直接恢复通用大字号会触发门禁；专用 token 同时保留默认尺寸和界面字号缩放。
    expect(styles).toContain("--text-ui-settings-title: calc(var(--ui-font-size) + 10px);");
    expect(styles).toContain("--text-ui-settings-title--line-height: calc(4 / 3);");
    expect(styles).toContain("--text-ui-settings-title-lg: calc(var(--ui-font-size) + 16px);");
    expect(styles).toContain("--text-ui-settings-title-lg--line-height: 1.2;");
  });

  it("does not emit arbitrary geometry or component-level semantic alpha", () => {
    const violations: string[] = [];

    for (const relativePath of remoteUiSources) {
      let source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      // RemoteConnectionDirectoryStep 的旧 loading 占位高度不属于本次 R3 改动，单独留给历史迁移。
      if (relativePath === "../src/RemoteConnectionDialogContent.tsx") {
        source = source.replace(/min-h-\[22rem\]/gu, "");
      }
      // Windows 设置页外框沿用 workspaceShellWindowChrome 的 5px 系统窗口圆角，属于桌面窗口外沿而非 R3 远程 UI。
      if (relativePath === "../src/SettingsPage.tsx") {
        source = source.replace(/rounded-\[5px\]/gu, "");
      }
      for (const pattern of forbiddenPatterns) {
        const match = pattern.exec(source);
        if (match) {
          violations.push(`${relativePath}: ${match[0]}`);
        }
      }
    }

    expect(violations).toEqual([]);
    const model = readFileSync(
      new URL("../src/lib/remoteConnectionPresentation.ts", import.meta.url),
      "utf8",
    );
    expect(model).not.toMatch(/(?:bg|text)-remote-(?:ssh|wsl|docker)/u);
  });
});
