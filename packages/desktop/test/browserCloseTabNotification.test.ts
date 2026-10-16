import { describe, expect, it } from "vitest";
import { buildBrowserViewCloseTabNotification } from "../src/main/browserView/browserCloseTabNotification.js";

/**
 * 这条链路此前完全没有测试防护：字段拼装原先内联在 `index.ts` 的 manager 构造回调里（Electron 入口不进单测），
 * 而唯一的 E2E（BTC01）走 `closeTabFromRenderer` → `notifyRenderer=false`，结构上就不经过这段代码。
 * 拼错字段名或漏掉 scope 会让"用户切走 workspace 后 Agent 关 tab"重新退化成关不掉的幽灵 tab，
 * 但 main 单测、renderer 单测、E2E 会全部保持绿色 —— 所以这里必须逐字段精确断言。
 */
describe("buildBrowserViewCloseTabNotification", () => {
  it("remote workspace 的 owner 逐字段落到 renderer 能路由的 scope 上", () => {
    // 三个值彼此明显不同，字段串位（例如把 sessionId 写进 workspaceKey）会立刻被 toEqual 抓住。
    expect(
      buildBrowserViewCloseTabNotification("browser:tab-a", {
        workspaceKey: "ssh://host/repo",
        sessionId: "session-a",
        remoteSessionId: "remote-a",
      }),
    ).toEqual({
      tabId: "browser:tab-a",
      workspaceKey: "ssh://host/repo",
      sessionId: "session-a",
      remoteSessionId: "remote-a",
    });
  });

  it("本地 workspace 不产出 remoteSessionId 这个 key，而不是给它一个 undefined", () => {
    const notification = buildBrowserViewCloseTabNotification("browser:tab-b", {
      workspaceKey: "/repo",
      sessionId: "session-b",
    });

    expect(notification).toEqual({
      tabId: "browser:tab-b",
      workspaceKey: "/repo",
      sessionId: "session-b",
    });
    // renderer 按“字段是否存在”判定作用域，显式 undefined 会经 IPC 结构化克隆后表现不同。
    expect(Object.hasOwn(notification, "remoteSessionId")).toBe(false);
  });

  it("空字符串 remoteSessionId 视为缺席，避免 renderer 拿到空 scope 误判 remote", () => {
    const notification = buildBrowserViewCloseTabNotification("browser:tab-c", {
      workspaceKey: "/repo",
      sessionId: "session-c",
      remoteSessionId: "",
    });

    expect(Object.hasOwn(notification, "remoteSessionId")).toBe(false);
  });

  it("owner 缺省时只带 tabId，保留 recovery-orphan 路径的“仅当前 workspace”语义", () => {
    const notification = buildBrowserViewCloseTabNotification("browser:tab-d");

    expect(notification).toEqual({ tabId: "browser:tab-d" });
    expect(Object.hasOwn(notification, "workspaceKey")).toBe(false);
    expect(Object.hasOwn(notification, "sessionId")).toBe(false);
  });
});
