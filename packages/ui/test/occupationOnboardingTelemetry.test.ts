// @vitest-environment jsdom
import { createElement, StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";

const mocks = vi.hoisted(() => ({
  report: vi.fn(async (_event: unknown) => {}),
  update: vi.fn(async (_patch: unknown) => {}),
  requested: true,
  needs: false as boolean | null,
  settingsReady: true,
  locale: "zh" as "zh" | "en",
  store: {} as Record<string, unknown>,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ reportTelemetryEvent: mocks.report, getDeviceId: () => "record-device" }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: mocks.settingsReady ? { onboardingOccupation: "developer" } : null,
    update: mocks.update,
  }),
}));
vi.mock("@/hooks/useOnboardingRecordService.js", () => ({
  useOnboardingRecordService: () => null,
}));
vi.mock("@/onboarding/useOnboardingTrigger.js", () => ({
  useOnboardingTrigger: () => [mocks.needs, vi.fn()],
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({ ...mocks.store, newUserOnboardingOpen: mocks.requested }),
}));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useEffectiveShortcutBindings: () => ({ toggleInterfaceMode: [], openOnboarding: ["Alt+o"] }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => (mocks.locale === "zh" ? zhCN : enUS)[id] ?? id,
    },
  }),
}));
vi.mock("@/onboarding/OccupationOnboardingVisual.js", () => ({
  OccupationOnboardingVisual: () => null,
}));
vi.mock("@/DesktopWindowControls.js", () => ({ DesktopWindowControls: () => null }));
vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

function events(elementName: string) {
  return mocks.report.mock.calls
    .map(
      ([event]) =>
        event as {
          elementName: string;
          eventText: string;
          eventExtraDetail: Record<string, string>;
        },
    )
    .filter((e) => e.elementName === elementName);
}
function mount() {
  return render(
    createElement(StrictMode, null, createElement(OccupationOnboarding, { children: "Home" })),
  );
}
function next() {
  fireEvent.click(screen.getByRole("button", { name: mocks.locale === "zh" ? "下一步" : "Next" }));
}
function preferences() {
  next();
  next();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue(undefined);
  mocks.report.mockResolvedValue(undefined);
  mocks.requested = true;
  mocks.needs = false;
  mocks.settingsReady = true;
  mocks.locale = "zh";
  mocks.store = {
    interfaceMode: "office",
    user: { id: "u1" },
    setInterfaceMode: vi.fn(),
    setNewUserOnboardingOpen: (v: boolean) => {
      mocks.requested = v;
    },
    requestOnboardingDialog: vi.fn(),
  };
});
afterEach(cleanup);
describe("onboarding telemetry through real component interactions", () => {
  it("does not report unseen preference resets when reselecting the same mode", () => {
    mount();
    preferences();
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(screen.getByRole("button", { name: /办公模式/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(events("onboarding_end")[0]?.eventExtraDetail.workspace_memory_enabled).toBe("null");
  });

  it.each(["start", "skip"])("uses actual English %s text", async (action) => {
    mocks.locale = "en";
    mount();
    preferences();
    const text = action === "start" ? "Get started" : "Skip";
    fireEvent.click(screen.getByRole("button", { name: text }));
    await waitFor(() => expect(events("onboarding_end")).toHaveLength(1));
    expect(events("onboarding_end")[0]?.eventText).toBe(text);
  });
  it("keyboard toggle closes through the same end boundary", () => {
    mount();
    fireEvent.keyDown(window, { key: "o", altKey: true });
    expect(events("onboarding_end")[0]?.eventExtraDetail.exit_action).toBe("close");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ["developer", "software_data_ai"],
    ["independent", "entrepreneurship_freelance_opc"],
    ["infrastructure", "qa_operations_security"],
    ["product", "product_project_solutions"],
    ["design", "ui_ux_visual_design"],
    ["student", "education_research"],
    ["finance", "finance_accounting_consulting"],
    ["creator", "media_content_creation"],
    ["operations", "business_operations_ecommerce_customer_service"],
    ["marketing", "marketing_brand_pr"],
    ["legal", "legal_administration_hr"],
    ["other", "other"],
  ])("maps %s to a stable English work direction", (occupation, expected) => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: zhCN[`occupationOnboarding.${occupation}`] }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(events("onboarding_end")[0]?.eventExtraDetail.work_direction).toBe(expected);
    expect(events("onboarding_expose")[0]).toMatchObject({ eventRegion: "app.onboarding" });
    expect(events("onboarding_end")[0]).toMatchObject({ eventRegion: "app.onboarding" });
  });
  it("reports automatic onboarding and ignores unmount as close", () => {
    mocks.requested = false;
    mocks.needs = true;
    const view = mount();
    expect(events("onboarding_expose")).toHaveLength(1);
    view.unmount();
    expect(events("onboarding_end")).toHaveLength(0);
  });
  it("a new opening after visiting preferences starts with no visited mode/preferences", () => {
    const view = mount();
    preferences();
    fireEvent.keyDown(window, { key: "Escape" });
    mocks.requested = true;
    view.rerender(
      createElement(StrictMode, null, createElement(OccupationOnboarding, { children: "Home" })),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(events("onboarding_end")[1]?.eventExtraDetail).toMatchObject({
      ui_mode: "null",
      workspace_memory_enabled: "null",
      exit_step: "1",
    });
  });

  it("waits for actual display and deduplicates StrictMode, rerenders and steps", () => {
    mocks.settingsReady = false;
    const view = mount();
    expect(events("onboarding_expose")).toHaveLength(0);
    mocks.settingsReady = true;
    view.rerender(
      createElement(StrictMode, null, createElement(OccupationOnboarding, { children: "Home" })),
    );
    expect(events("onboarding_expose")).toHaveLength(1);
    preferences();
    expect(events("onboarding_expose")).toHaveLength(1);
    expect(events("onboarding_end")).toHaveLength(0);
  });
  it.each(["start", "skip"])("reports %s snapshot only after successful save", async (action) => {
    mount();
    preferences();
    const checks = screen.getAllByRole("checkbox");
    fireEvent.click(checks[0]!);
    fireEvent.click(checks[2]!);
    let finish!: () => void;
    mocks.update.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: action === "start" ? "开始使用" : "跳过" }));
    expect(events("onboarding_end")).toHaveLength(0);
    mocks.locale = "en";
    await act(async () => {
      finish();
    });
    expect(events("onboarding_end")).toEqual([
      expect.objectContaining({
        eventText: action === "start" ? "开始使用" : "跳过",
        eventExtraDetail: {
          work_direction: "software_data_ai",
          ui_mode: "work",
          proactive_task_recommendations_enabled: "false",
          workspace_memory_enabled: "true",
          claude_code_history_migration_selected: "true",
          exit_action: action,
          exit_step: "3",
        },
      }),
    ]);
    expect(mocks.store.requestOnboardingDialog).toHaveBeenCalledTimes(action === "start" ? 1 : 0);
  });
  it.each([0, 1, 2])("close on step %s includes only visited answers without saving", (step) => {
    mount();
    for (let i = 0; i < step; i++) next();
    fireEvent.keyDown(window, { key: "Escape" });
    const end = events("onboarding_end");
    expect(end).toHaveLength(1);
    expect(end[0]?.eventText).toBe("退出引导");
    expect(end[0]?.eventExtraDetail).toMatchObject({
      exit_action: "close",
      exit_step: String(step + 1),
      work_direction: "software_data_ai",
      ui_mode: step ? "work" : "null",
      workspace_memory_enabled: step === 2 ? "true" : "null",
    });
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(events("onboarding_end")).toHaveLength(1);
  });
  it("invalidates preferences after changing mode, even when switching back", () => {
    mount();
    preferences();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(screen.getByRole("button", { name: /编程模式/ }));
    fireEvent.click(screen.getByRole("button", { name: /办公模式/ }));
    fireEvent.click(screen.getByRole("button", { name: "退出引导" }));
    expect(events("onboarding_end")[0]?.eventExtraDetail).toMatchObject({
      ui_mode: "work",
      workspace_memory_enabled: "null",
      proactive_task_recommendations_enabled: "null",
      claude_code_history_migration_selected: "null",
    });
  });
  it("preserves skipped single-choice answers and code-only hidden preference", async () => {
    mocks.store.interfaceMode = "coding";
    mount();
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    next();
    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
    await waitFor(() => expect(events("onboarding_end")).toHaveLength(1));
    expect(events("onboarding_end")[0]?.eventExtraDetail).toMatchObject({
      work_direction: "null",
      ui_mode: "code",
      proactive_task_recommendations_enabled: "null",
    });
  });
  it("does not report failed save; a retry succeeds once", async () => {
    mocks.update.mockRejectedValueOnce(new Error("save failed"));
    mount();
    preferences();
    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
    await screen.findByRole("alert");
    expect(events("onboarding_end")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
    await waitFor(() => expect(events("onboarding_end")).toHaveLength(1));
  });
  it("English close text, reopen and reporting failure do not block UI", () => {
    mocks.locale = "en";
    mocks.report.mockRejectedValue(new Error("offline"));
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Exit onboarding" }));
    expect(screen.queryByTestId("onboarding-page")).toBeNull();
    expect(events("onboarding_end")[0]?.eventText).toBe("Exit onboarding");
    mocks.requested = true;
    view.rerender(
      createElement(StrictMode, null, createElement(OccupationOnboarding, { children: "Home" })),
    );
    expect(events("onboarding_expose")).toHaveLength(2);
  });
});
