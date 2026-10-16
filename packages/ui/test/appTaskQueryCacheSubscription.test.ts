import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readUiSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

function expectNoTaskQueryCacheHookSubscription(source: string) {
  // 性能回归保护：task meta 高频刷新只应在命令触发时通过 getState 读取快照，
  // 不应让 App 或导航 hook 订阅整个 task query cache 后带动 shell 重渲染。
  expect(source).not.toMatch(/\buseTaskQueryCacheStore\s*\(/);
}

describe("task query cache render subscription boundary", () => {
  it("keeps App from subscribing to the whole task query cache", () => {
    expectNoTaskQueryCacheHookSubscription(readUiSource("App.tsx"));
  });

  it("keeps task navigation handlers from subscribing to the whole task query cache", () => {
    const source = readUiSource("app-shell/useWorkspaceTaskNavigation.ts");
    expectNoTaskQueryCacheHookSubscription(source);
    expect(source).toContain("setTaskQueryCacheUnreadOverlay");
    expect(source).toContain("reconcileTaskQueryCacheUnread");
    expect(source).not.toContain("setTaskUnreadIndicator");
    expect(source).not.toContain("targetWorkspaceState.taskListCache");
  });

  it("选择已有 task 时保留 workspace slash command 目录", () => {
    const source = readUiSource("app-shell/useWorkspaceTaskNavigation.ts");
    // Bug 原因：目录属于 workspace identity；task 导航若主动清空，session projection
    // 不会替 composer 回填，已知 session 的自定义 slash command 会永久消失。
    expect(source).not.toMatch(/\.setSlashCommands\s*\(/);
    expect(source).not.toMatch(/const\s+setSlashCommands\s*=\s*useZCodeSessionStore/);
  });
});
