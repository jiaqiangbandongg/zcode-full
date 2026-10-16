// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig, BotState } from "@zcode/shared";
import { BoundGroupsCard, BoundGroupsList } from "@/BotsDialog/BoundGroupsCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const mocks = vi.hoisted(() => ({
  getBotStates: vi.fn(),
  setGroupEnabled: vi.fn(),
  onMessage: vi.fn((_listener: (message: { channel: string }) => void) => ({ dispose: vi.fn() })),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ botsService: mocks, broadcastService: mocks }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
const bot = { id: "bot", provider: "feishu", providerUserId: "owner", enabled: true } as BotConfig;
const group = (enabled = true): BotState => ({
  botId: "bot",
  workspacePath: "/w",
  mode: "task",
  activeTaskId: "SECRET_TASK",
  updatedAt: 1,
  group: {
    chatId: "chat",
    name: "产品讨论群",
    ownerId: "owner",
    enabled,
    taskIds: ["SECRET_TASK"],
    currentOptions: {},
  },
});
const show = (enabled = true) =>
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(BoundGroupsCard, { bot: { ...bot, enabled } }),
    ),
  );
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  mocks.onMessage.mockReturnValue({ dispose: vi.fn() });
});
describe("bound group controls", () => {
  it.each([
    ["en-US", 0, "0 topics"],
    ["en-US", 1, "1 topic"],
    ["en-US", 2, "2 topics"],
    ["zh-CN", 0, "0 个话题"],
    ["zh-CN", 1, "1 个话题"],
    ["zh-CN", 2, "2 个话题"],
  ] as const)("renders %s topic count %s with the real formatter", (locale, count, label) => {
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(BoundGroupsList, {
          rows: [{ chatId: "chat", name: "产品讨论群", enabled: true, topicCount: count }],
          disabled: false,
          saving: null,
          onToggle: vi.fn(),
        }),
      ),
    );
    expect(screen.getByText(label)).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/[{}#]/);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });
  it("shows one compact row without tasks and waits for save confirmation", async () => {
    mocks.getBotStates.mockResolvedValue([group()]);
    let finish!: () => void;
    mocks.setGroupEnabled.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = show();
    const toggle = await screen.findByRole("switch");
    expect(view.container.textContent).toContain("0 个话题");
    expect(view.container.textContent).not.toContain("SECRET_TASK");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(mocks.setGroupEnabled).toHaveBeenCalledWith({
      botId: "bot",
      chatId: "chat",
      enabled: false,
    });
    mocks.getBotStates.mockResolvedValue([group(false)]);
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });
  it("keeps the original switch and shows an error on rejected saves", async () => {
    mocks.getBotStates.mockResolvedValue([group()]);
    mocks.setGroupEnabled.mockRejectedValue(new Error("offline"));
    show();
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    await screen.findByRole("alert");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(false);
  });
  it("does not mistake a no-op service response for a saved authorization", async () => {
    mocks.getBotStates.mockResolvedValue([group()]);
    mocks.setGroupEnabled.mockResolvedValue(undefined);
    show();
    fireEvent.click(await screen.findByRole("switch"));
    await screen.findByRole("alert");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });
  it("ignores an old failed read after a newer group broadcast succeeds", async () => {
    let rejectOld!: (error: Error) => void;
    mocks.getBotStates
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValue([group(false)]);
    show();
    await act(async () => {
      mocks.onMessage.mock.calls[0]![0]({ channel: "bots:group-state" });
    });
    await screen.findByRole("switch");
    await act(async () => {
      rejectOld(new Error("stale"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });
  it("disables group controls when the bot is off", async () => {
    mocks.getBotStates.mockResolvedValue([group()]);
    show(false);
    const toggle = await screen.findByRole("switch");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(mocks.setGroupEnabled).not.toHaveBeenCalled();
  });
  it("distinguishes failed loading from an empty list and permits refresh", async () => {
    mocks.getBotStates.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    show();
    await screen.findByRole("alert");
    expect(screen.queryByText(/暂无绑定群聊/)).toBeNull();
    fireEvent.click(screen.getByText("刷新"));
    await screen.findByText(/暂无绑定群聊/);
  });
});
