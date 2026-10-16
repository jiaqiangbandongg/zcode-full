import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readUiSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

describe("Root Web remote task sync subscription boundary", () => {
  it("全局数据库门禁移出 Root，正常启动壳仍保留远控同步边界", () => {
    const rootSource = readUiSource("Root.tsx");
    expect(rootSource).not.toContain("useStorageStartup");
    const startupBranch = rootSource.slice(rootSource.indexOf("if (isStartupRenderBlocked)"));
    expect(startupBranch).toContain("{webRemoteControlTaskSyncNode}");
  });
  it("keeps the Root shell from subscribing to all workspaces when Web remote task sync is disabled", () => {
    const rootSource = readUiSource("Root.tsx");
    const rootInnerSource = rootSource.slice(rootSource.indexOf("function RootInner"));
    const webRemoteTaskSyncSource = rootSource.slice(
      rootSource.indexOf("function WebRemoteControlTaskSync"),
      rootSource.indexOf("/**\n * Root"),
    );

    // 性能回归保护：桌面 continuous 主链路没有开启 Web remote 时，
    // Root 不能为了远控 task 索引订阅整张 workspace 表，否则流式更新会唤醒整棵 shell。
    expect(rootInnerSource).not.toContain("useZCodeSessionStore((state) => state.workspaces)");
    expect(webRemoteTaskSyncSource).toContain("useZCodeSessionStore((state) => state.workspaces)");
    expect(rootSource).toMatch(/hasCompletedFullRestore\s*&&\s*webRemoteControlTaskSyncEnabled/);
  });
});
