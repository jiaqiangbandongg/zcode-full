// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_BROWSER_PERMISSION_ALLOW_ALWAYS,
  TID_BROWSER_PERMISSION_ALLOW_ONCE,
  TID_BROWSER_PERMISSION_DENY,
  TID_BROWSER_PERMISSION_DISMISS,
  TID_BROWSER_PERMISSION_PROMPTS,
  type EmbeddedBrowserPermissionPromptEvent,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// 与组件相同的 "@/..." 说明符：vitest alias 下相对路径与别名会解析成两个模块实例，
// 导致 setState 与组件订阅落在不同 store 上。
import { useEmbeddedBrowserPermissionStore } from "@/store/embeddedBrowserPermissionStore.js";

/** 模拟 main 的设备列表热更新：同 requestId 的推送应替换列表而非追加。 */
function pushDeviceListUpdate(requestId: string, devices: Array<{ deviceId: string; name?: string }>) {
  useEmbeddedBrowserPermissionStore
    .getState()
    .receivePrompt({
      requestId,
      kind: "device",
      origin: "https://example.com",
      permission: "select-bluetooth-device",
      devices,
    });
}

const resolveEmbeddedBrowserPermissionPrompt = vi.fn();

// 真实环境的 platform 是稳定单例；mock 若每次渲染返回新对象，加载 effect 的依赖会失效。
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    onEmbeddedBrowserPermissionPrompt: () => () => undefined,
    resolveEmbeddedBrowserPermissionPrompt,
  }),
}));

const { EmbeddedBrowserPermissionPrompts } = await import(
  "@/browser-use/EmbeddedBrowserPermissionPrompts.js"
);

function renderWithPrompts(
  prompts: EmbeddedBrowserPermissionPromptEvent[],
  guestWebContentsId?: number,
) {
  useEmbeddedBrowserPermissionStore.setState({ prompts });
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(EmbeddedBrowserPermissionPrompts, { guestWebContentsId }),
    ),
  );
}

const permissionPrompt: EmbeddedBrowserPermissionPromptEvent = {
  requestId: "req-1",
  kind: "permission",
  origin: "https://example.com",
  permission: "media",
  mediaTypes: ["video"],
};

beforeEach(() => {
  useEmbeddedBrowserPermissionStore.setState({ prompts: [] });
  resolveEmbeddedBrowserPermissionPrompt.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("EmbeddedBrowserPermissionPrompts Chrome 式权限气泡", () => {
  it("无请求时不渲染气泡", () => {
    renderWithPrompts([]);
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("渲染 origin、按 mediaTypes 细分的权限名与 阻止/允许/✕ 按钮", () => {
    renderWithPrompts([permissionPrompt]);
    expect(screen.getByText("https://example.com")).toBeTruthy();
    // mediaTypes: ["video"] → 摄像头，而不是笼统的「摄像头和麦克风」
    expect(screen.getByText("摄像头")).toBeTruthy();
    expect(screen.queryByText("摄像头和麦克风")).toBeNull();
    // 平铺三选项：不允许 / 仅本次允许 / 访问此网站时允许
    expect(screen.getByRole("button", { name: "不允许" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "仅本次允许" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "访问此网站时允许" })).toBeTruthy();
    // 气泡头部带 ✕ 关闭（= 不允许·本次），仍不提供「永久阻止」
    expect(screen.queryByRole("button", { name: "阻止" })).toBeNull();
    expect(screen.getByTestId(TID_BROWSER_PERMISSION_DISMISS)).toBeTruthy();
  });

  it("clipboard-read 显示「读取剪贴板」", () => {
    renderWithPrompts([
      { ...permissionPrompt, permission: "clipboard-read", mediaTypes: undefined },
    ]);
    expect(screen.getByText("读取剪贴板")).toBeTruthy();
  });

  it("「仅本次允许」回传 allow-session 并出队", () => {
    renderWithPrompts([permissionPrompt]);
    fireEvent.click(screen.getByTestId(TID_BROWSER_PERMISSION_ALLOW_ONCE));
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-1",
      resolution: { action: "allow-session" },
    });
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("「访问此网站时允许」回传 allow-always", () => {
    renderWithPrompts([permissionPrompt]);
    fireEvent.click(screen.getByTestId(TID_BROWSER_PERMISSION_ALLOW_ALWAYS));
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-1",
      resolution: { action: "allow-always" },
    });
  });

  it("「不允许」回传 dismiss（本次拒绝，不记忆）", () => {
    renderWithPrompts([permissionPrompt]);
    fireEvent.click(screen.getByTestId(TID_BROWSER_PERMISSION_DENY));
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-1",
      resolution: { action: "dismiss" },
    });
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("permission 请求按 guest 归属过滤：后台 tab 的请求不在当前 tab 渲染", () => {
    // 当前 tab 的 guest id = 42；请求来自 99（后台 tab）
    renderWithPrompts(
      [{ ...permissionPrompt, guestWebContentsId: 99 }],
      42,
    );
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();

    // 请求来自当前 tab（42）：渲染
    cleanup();
    renderWithPrompts(
      [{ ...permissionPrompt, guestWebContentsId: 42 }],
      42,
    );
    expect(screen.getByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeTruthy();
    expect(screen.getByText("https://example.com")).toBeTruthy();

    // 请求缺归属 id（兜底路径）：渲染并由 origin 标明来源
    cleanup();
    renderWithPrompts([permissionPrompt], 42);
    expect(screen.getByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeTruthy();

    // 当前 tab 无 guest（空 tab）：同样只渲染兜底请求
    cleanup();
    renderWithPrompts([{ ...permissionPrompt, guestWebContentsId: 99 }], undefined);
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("✕ 关闭回传 dismiss（本次拒绝，不记忆）", () => {
    renderWithPrompts([permissionPrompt]);
    fireEvent.click(screen.getByTestId(TID_BROWSER_PERMISSION_DISMISS));
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-1",
      resolution: { action: "dismiss" },
    });
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("media 同时申请摄像头与麦克风时能力列表列两行", () => {
    renderWithPrompts([{ ...permissionPrompt, mediaTypes: ["video", "audio"] }]);
    expect(screen.getByText("摄像头")).toBeTruthy();
    expect(screen.getByText("麦克风")).toBeTruthy();
    expect(screen.queryByText("摄像头和麦克风")).toBeNull();
  });

  it("不同请求可并存渲染", () => {
    renderWithPrompts([
      permissionPrompt,
      { ...permissionPrompt, requestId: "req-2", permission: "geolocation" },
    ]);
    expect(screen.getByText("摄像头")).toBeTruthy();
    expect(screen.getByText("位置信息")).toBeTruthy();
  });
});

describe("EmbeddedBrowserPermissionPrompts 选择器弹窗", () => {
  it("屏幕共享弹窗按「整个屏幕 / 窗口」分组列出源", () => {
    renderWithPrompts([
      {
        requestId: "req-share",
        kind: "screen-share",
        origin: "https://meet.example.com",
        screens: [
          {
            sourceId: "screen:1",
            name: "Entire Screen",
            kind: "screen",
            thumbnailDataUrl: "data:image/jpeg;base64,AAAA",
          },
          { sourceId: "window:2", name: "Doc — Preview", kind: "window" },
          { sourceId: "window:3", name: "Terminal", kind: "window" },
        ],
      },
    ]);
    // 标题含 ICU 插值（{origin} 想要共享你的屏幕），按 textContent 包含断言
    expect(
      screen.getAllByText(
        (_, element) => element?.textContent?.includes("https://meet.example.com") ?? false,
      ).length,
    ).toBeGreaterThan(0);
    // 分组标题
    expect(screen.getByText("整个屏幕")).toBeTruthy();
    expect(screen.getByText("窗口")).toBeTruthy();
    expect(screen.getByText("Doc — Preview")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "共享" })).toBeTruthy();
  });

  it("同 requestId 的推送热更新设备列表（蓝牙扫描渐进出设备）", async () => {
    renderWithPrompts([
      {
        requestId: "req-bt",
        kind: "device",
        origin: "https://example.com",
        permission: "select-bluetooth-device",
        devices: [],
      },
    ]);
    // 首扫为空：列表无设备
    expect(screen.queryByText("Headphones")).toBeNull();

    pushDeviceListUpdate("req-bt", [{ deviceId: "bt-1", name: "Headphones" }]);
    await waitFor(() => expect(screen.getByText("Headphones")).toBeTruthy());
  });

  it("设备选择弹窗列出设备名与厂商/序列号元信息，未选中时连接按钮禁用", () => {
    renderWithPrompts([
      {
        requestId: "req-device",
        kind: "device",
        origin: "https://example.com",
        permission: "select-hid-device",
        devices: [
          {
            deviceId: "dev-1",
            name: "Ledger Nano",
            vendorId: 0x2c97,
            productId: 0x0001,
            serialNumber: "SN123",
          },
        ],
      },
    ]);
    expect(screen.getByText("Ledger Nano")).toBeTruthy();
    expect(screen.getByText("2c97:0001 · SN123")).toBeTruthy();

    const connectButton = screen.getByRole("button", { name: "连接" });
    expect((connectButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText("Ledger Nano"));
    expect((connectButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(connectButton);
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-device",
      resolution: { action: "select-device", deviceId: "dev-1" },
    });
  });
});
