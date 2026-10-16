// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

const h = vi.hoisted(() => {
  const initialize = vi.fn(async () => {});
  const dismissNewTaskBanner = vi.fn();
  const setPendingCreateDraft = vi.fn();
  const refreshCodingPlanSupport = vi.fn(async () => {});
  const openCodingPlanUpgrade = vi.fn();
  const inventory = { status: "ready" as "ready" | "loading" | "error", retry: vi.fn() };
  const loggerDebug = vi.fn();
  const toast = vi.fn();
  const messages: { current: Record<string, string> } = { current: {} };
  const locale = { current: "en-US" };
  const offPeakTemplateIds = {
    current: ["standupGitSummary", "ciFlakyReport", "customize"] as string[],
  };
  const remoteTemplateCopy = {
    standupGitSummary: {
      en: {
        title: "Remote standup summary",
        description: "Remote Friday summary",
        prompt: "Summarize the remote standup.",
      },
      cn: { title: "远程站会摘要", description: "远程周五摘要", prompt: "汇总远程站会。" },
    },
    ciFlakyReport: {
      en: {
        title: "Remote CI report",
        description: "Remote CI failures",
        prompt: "Review the remote CI report.",
      },
      cn: { title: "远程 CI 报告", description: "远程 CI 失败", prompt: "检查远程 CI 报告。" },
    },
    documentationSyncCheck: {
      en: {
        title: "Remote docs check",
        description: "Remote documentation sync",
        prompt: "Review remote documentation.",
      },
      cn: { title: "远程文档检查", description: "远程文档同步", prompt: "检查远程文档。" },
    },
  };
  const providerSettingsState = {
    view: null as import("@zcode/services").ProviderSettingsView | null,
  };
  const state = {
    loading: false,
    grayConfig: {
      enabled: true,
      modelSelectionView: { revision: 1, providers: [] },
    },
    codingPlanSupport: {
      supported: false,
      reason: "connection_unselected",
    },
    newTaskBannerDismissed: false,
    initialize,
    refreshCodingPlanSupport,
    dismissNewTaskBanner,
    setPendingCreateDraft,
  };
  const settings = {
    providerFamilyDomain: undefined as "zai" | "bigmodel" | undefined,
    modelProviderFamilyModes: {} as Record<string, "oauth" | "apiKey">,
    modelProviderFamilySelectedKeys: {} as Record<string, string>,
  };
  // 真实 useServices 返回的是稳定的 Context 值；mock 若每次调用都新建对象，
  // 组件任何一次重渲染都会让 initialize 的依赖变化并重复拉取灰度配置。
  const services = {
    offPeakTaskService: {},
    codingPlanSubscriptionService: {},
  };
  return {
    initialize,
    loggerDebug,
    locale,
    messages,
    offPeakTemplateIds,
    providerSettingsState,
    openCodingPlanUpgrade,
    inventory,
    refreshCodingPlanSupport,
    services,
    setPendingCreateDraft,
    settings,
    state,
    toast,
    remoteTemplateCopy,
  };
});

vi.mock("@/components/ui/toast.js", () => ({ toast: h.toast }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => h.services,
}));
vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: h.providerSettingsState.view
      ? { status: "ready", view: h.providerSettingsState.view }
      : { status: "loading" },
    reload: vi.fn(),
  }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: h.settings }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: h.locale.current,
    intl: {
      formatMessage: ({ id }: { id: string }) => h.messages.current[id] ?? id,
    },
  }),
}));
vi.mock("@/settings/useAutomationTemplates.js", () => ({
  useAutomationTemplates: () => ({
    scheduled: [],
    rejectedScheduledTemplateIds: [],
    offPeak: h.offPeakTemplateIds.current.map((id) => {
      const customize = id === "customize" || id === "item-customize";
      const copy = customize
        ? null
        : h.remoteTemplateCopy[
            id as "standupGitSummary" | "ciFlakyReport" | "documentationSyncCheck"
          ];
      return {
        id,
        title: copy ? { en: copy.en.title, cn: copy.cn.title } : {},
        // Automations 仍展示 contents；首页必须显式读取 homepageDescription（descs 映射结果）。
        description: copy
          ? { en: `contents:${copy.en.description}`, cn: `contents:${copy.cn.description}` }
          : {},
        homepageDescription: copy ? { en: copy.en.description, cn: copy.cn.description } : {},
        prompt: copy ? { en: copy.en.prompt, cn: copy.cn.prompt } : { en: "", cn: "" },
        customize,
        icon: customize ? "customize" : id,
        ...(customize
          ? {}
          : {
              iconName:
                id === "standupGitSummary"
                  ? "git-commit-horizontal"
                  : id === "ciFlakyReport"
                    ? "activity"
                    : "file-text",
            }),
      };
    }),
  }),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: h.loggerDebug },
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useOptionalCodingPlanUpgradeDialog: () => ({
    openCodingPlanUpgrade: h.openCodingPlanUpgrade,
    inventory: h.inventory,
  }),
}));
vi.mock("@/store/offPeakTaskStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/offPeakTaskStore.js")>();
  return {
    ...actual,
    useOffPeakTaskStore: (selector: (state: typeof h.state) => unknown) => selector(h.state),
  };
});

import { OffPeakNewTaskEntry } from "@/v4/OffPeakNewTaskEntry.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

function renderEntry(props: { onOpenAutomations?: () => void } = {}) {
  return render(createElement(OffPeakNewTaskEntry, props));
}

function getEntryRoot(container: HTMLElement) {
  return container.querySelector<HTMLElement>("[data-off-peak-new-task-entry]");
}

function clickStandupTemplate(onOpenAutomations = vi.fn()) {
  renderEntry({ onOpenAutomations });
  fireEvent.click(
    screen.getByRole("button", {
      name: /Remote standup summary Remote Friday summary/,
    }),
  );
  return onOpenAutomations;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.inventory.status = "ready";
  h.state.loading = false;
  h.state.grayConfig = {
    enabled: true,
    modelSelectionView: { revision: 1, providers: [] },
  };
  h.state.codingPlanSupport = {
    supported: false,
    reason: "connection_unselected",
  };
  h.providerSettingsState.view = {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: [],
  };
  h.messages.current = {};
  h.locale.current = "en-US";
  h.offPeakTemplateIds.current = ["standupGitSummary", "ciFlakyReport", "customize"];
  h.settings.providerFamilyDomain = undefined;
  h.settings.modelProviderFamilyModes = {};
  h.settings.modelProviderFamilySelectedKeys = {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OffPeakNewTaskEntry", () => {
  it.each(["loading", "error"] as const)(
    "purchase inventory %s does not enter purchase from the blocked template",
    (status) => {
      h.inventory.status = status;
      const onOpenAutomations = clickStandupTemplate();
      const options = h.toast.mock.calls[0]?.[1];
      expect(h.setPendingCreateDraft).not.toHaveBeenCalled();
      expect(onOpenAutomations).not.toHaveBeenCalled();
      if (status === "loading") {
        expect(options?.actionLabel).toBeUndefined();
      } else {
        expect(options?.actionLabel).toBe("purchase.entry.retry");
        options?.onAction?.();
        expect(h.inventory.retry).toHaveBeenCalledOnce();
      }
      expect(h.openCodingPlanUpgrade).not.toHaveBeenCalled();
    },
  );

  it("远程目录为空时显示本地 Customize 入口", () => {
    h.offPeakTemplateIds.current = [];

    renderEntry();

    expect(screen.getByRole("button", { name: /Customize/i })).not.toBeNull();
  });

  it("首页只展示前两条普通远程模板，并把本地 Customize 固定放在最后", () => {
    h.offPeakTemplateIds.current = [
      "standupGitSummary",
      "item-customize",
      "ciFlakyReport",
      "documentationSyncCheck",
    ];

    const view = renderEntry();
    const cards = view.container.querySelectorAll<HTMLElement>(
      "[data-off-peak-template-grid] > button",
    );

    expect(cards).toHaveLength(3);
    expect(Array.from(cards, (card) => card.textContent)).toEqual([
      "Remote standup summaryRemote Friday summary",
      "Remote CI reportRemote CI failures",
      "offPeak.newTask.template.customize.titleoffPeak.newTask.template.customize.description",
    ]);
    expect(view.container.textContent).not.toContain("Remote docs check");
  });

  it("anchors the entry to the bottom of the draft page with a 38px inset", () => {
    const view = renderEntry();
    const entry = getEntryRoot(view.container);

    expect(entry?.classList.contains("pb-[38px]")).toBe(true);
    // 入口已从 composer 下方的 bottom dock 移出，不再靠 mt-6 与 composer 拉开间距，
    // 也不再依赖 @container/conversation 断点外扩（该容器只声明在 timeline 内部）。
    expect(entry?.classList.contains("mt-6")).toBe(false);
    expect(entry?.className).not.toContain("@min-[820px]/conversation:-mx-[54px]");
  });

  it("keeps the banner row and the template buttons 12px apart", () => {
    const view = renderEntry();
    const entry = getEntryRoot(view.container);

    expect(entry?.classList.contains("gap-3")).toBe(true);
    expect(entry?.classList.contains("gap-2")).toBe(false);
  });

  it("centers the banner and restores the 780px three-button row", () => {
    const view = renderEntry();
    const banner = view.container.querySelector<HTMLElement>("[data-off-peak-new-task-banner]");
    const templateGrid = view.container.querySelector<HTMLElement>("[data-off-peak-template-grid]");

    expect(banner?.classList.contains("justify-center")).toBe(true);
    expect(banner?.classList.contains("max-w-[580px]")).toBe(true);
    expect(templateGrid?.classList.contains("w-full")).toBe(true);
    expect(templateGrid?.classList.contains("max-w-[780px]")).toBe(true);
  });

  it("renders three equal template buttons horizontally with a narrow-screen fallback", async () => {
    const view = renderEntry();
    const templateGrid = view.container.querySelector<HTMLElement>("[data-off-peak-template-grid]");
    const cards = templateGrid?.querySelectorAll<HTMLElement>("button") ?? [];

    expect(templateGrid?.classList.contains("grid-cols-1")).toBe(true);
    expect(templateGrid?.classList.contains("sm:grid-cols-3")).toBe(true);
    expect(templateGrid?.classList.contains("gap-4")).toBe(true);
    expect(cards).toHaveLength(3);
    expect(view.container.querySelector('[data-slot="carousel"]')).toBeNull();
    expect(view.container.querySelector("[data-off-peak-carousel-dot]")).toBeNull();
    for (const card of cards) {
      expect(card.classList.contains("rounded-2xl")).toBe(true);
      expect(card.classList.contains("border-card-border")).toBe(true);
    }
    await waitFor(() => {
      expect(
        cards[0]?.querySelector('[data-client-scene-lucide-icon="git-commit-horizontal"]'),
      ).not.toBeNull();
      expect(cards[1]?.querySelector('[data-client-scene-lucide-icon="activity"]')).not.toBeNull();
    });
    expect(cards[2]?.querySelector('[data-off-peak-homepage-template-icon="moon"]')).not.toBeNull();
  });
  it("keeps the dismiss control implemented but hidden in this design round", () => {
    const view = renderEntry();
    const closeButton = view.container.querySelector<HTMLElement>(
      "[data-off-peak-new-task-dismiss]",
    );

    expect(closeButton).not.toBeNull();
    expect(closeButton?.classList.contains("hidden")).toBe(true);
  });

  it("limits localized template descriptions to two lines without a fixed height", () => {
    renderEntry();
    const description = screen.getByText("Remote Friday summary");
    const title = screen.getByText("Remote standup summary");

    expect(description.classList.contains("h-[54px]")).toBe(false);
    expect(description.classList.contains("line-clamp-2")).toBe(true);
    expect(description.classList.contains("line-clamp-3")).toBe(false);
    expect(description.classList.contains("text-wrap-phrase")).toBe(true);
    expect(description.classList.contains("text-ui-caption")).toBe(true);
    expect(description.classList.contains("text-ui-base")).toBe(false);
    expect(description.classList.contains("font-normal")).toBe(true);
    expect(title.classList.contains("text-ui-base")).toBe(true);
    expect(title.classList.contains("font-normal")).toBe(false);
  });

  it("uses matching Lucide glyphs for the announcement, close, and template actions", () => {
    const view = renderEntry();
    const closeButton = view.container.querySelector<HTMLElement>(
      "[data-off-peak-new-task-dismiss]",
    );
    const icons = view.container.querySelectorAll<SVGSVGElement>("svg");

    expect(icons.length).toBeGreaterThanOrEqual(5);
    for (const icon of icons) {
      expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(icon.getAttribute("stroke-width")).toBe("2");
    }
    expect(closeButton?.querySelector("svg")).not.toBeNull();
  });

  it("keeps the full banner copy visible and uses its entire area as the tooltip trigger", () => {
    renderEntry();

    const copy = screen.getByText("offPeak.newTask.bannerText");
    expect(copy.classList.contains("text-ui-caption")).toBe(true);
    expect(copy.classList.contains("text-ui-sm")).toBe(false);
    expect(copy.classList.contains("text-ui-base")).toBe(false);
    expect(copy.classList.contains("font-normal")).toBe(true);
    expect(copy.classList.contains("truncate")).toBe(false);
    expect(copy.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(copy.tabIndex).toBe(0);
    expect(copy.classList.contains("cursor-default")).toBe(true);
    expect(copy.classList.contains("cursor-help")).toBe(false);
    expect(copy.parentElement?.classList.contains("gap-1")).toBe(true);
    expect(copy.parentElement?.children).toHaveLength(2);
    expect(screen.queryByText("!")).toBeNull();
  });

  it("首次挂载交由共享机制初始化和登记 freshness，连接变化后刷新", () => {
    const view = renderEntry();

    expect(h.initialize).toHaveBeenCalledOnce();
    // 去重归 Store 所有；这里验证组件交付通知，不再要求它自行跳过首次通知。
    expect(h.refreshCodingPlanSupport).toHaveBeenCalledOnce();
    view.rerender(createElement(OffPeakNewTaskEntry));
    expect(h.refreshCodingPlanSupport).toHaveBeenCalledOnce();

    h.settings.providerFamilyDomain = "zai";
    h.settings.modelProviderFamilyModes = { zai: "oauth" };
    h.settings.modelProviderFamilySelectedKeys = { zai: "zai-coding-plan" };
    view.rerender(createElement(OffPeakNewTaskEntry));

    expect(h.refreshCodingPlanSupport).toHaveBeenCalledTimes(2);
  });

  it("非 Coding Plan 用户点击模板时直接弹升级 toast，并拦截草稿与导航", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("idle-funnel-home");
    h.messages.current["settings.modelProvider.codingPlan.upgrade"] = "升级";
    const onOpenAutomations = clickStandupTemplate();

    expect(h.toast).toHaveBeenCalledWith("offPeak.create.codingPlanToast", {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      actionLabel: "升级",
      onAction: expect.any(Function),
      dismissible: true,
      dismissLabel: "common.close",
    });
    expect(h.setPendingCreateDraft).not.toHaveBeenCalled();
    expect(onOpenAutomations).not.toHaveBeenCalled();
    expect(h.loggerDebug).toHaveBeenCalledWith(
      "[off-peak] blocked home template without any Coding Plan",
      { templateId: "standupGitSummary" },
    );

    const toastOptions = h.toast.mock.calls[0]?.[1];
    toastOptions?.onAction?.();
    expect(h.openCodingPlanUpgrade).toHaveBeenCalledWith({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      initialAudience: "personal",
      funnelContext: {
        purchaseFunnelId: "idle-funnel-home",
        upgradeSource: "session_idle_time",
        eventRegion: "app.session",
        eventText: "升级",
        entryPlanStatus: "no_plan",
        entryPlanLevel: "",
        entryPlanList: "",
        purchaseAudience: "personal",
        providerFamily: "zai",
        channel: "Z_AI",
      },
    });
  });

  it("Account Overlay 确认 Coding Plan 可用时放行闲时任务导航", () => {
    h.providerSettingsState.view = {
      revision: 2,
      addableProviders: [],
      providerOrder: [],
      providers: [
        {
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          enabled: true,
          executable: true,
          effectiveConfig: {
            label: "BigModel Coding Plan",
            access: {
              type: "zhipu-account",
              family: "bigmodel",
              mode: "individual-coding-plan",
              entitled: true,
            },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://example.com",
            },
            builtinModelIds: ["glm-5"],
            enabled: true,
          },
          issues: [],
          models: [],
        },
      ],
    };
    const onOpenAutomations = clickStandupTemplate();

    expect(h.toast).not.toHaveBeenCalled();
    expect(h.setPendingCreateDraft).toHaveBeenCalledOnce();
    expect(onOpenAutomations).toHaveBeenCalledOnce();
  });

  it("Provider Settings 尚未水合时不把未知状态误判为无套餐", () => {
    h.providerSettingsState.view = null;
    const onOpenAutomations = clickStandupTemplate();

    expect(h.toast).not.toHaveBeenCalled();
    expect(h.setPendingCreateDraft).toHaveBeenCalledOnce();
    expect(onOpenAutomations).toHaveBeenCalledOnce();
  });

  it("uses the visible English Upgrade copy as the idle-time event text", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("idle-funnel-en");
    h.messages.current["settings.modelProvider.codingPlan.upgrade"] = "Upgrade";
    clickStandupTemplate();

    const toastOptions = h.toast.mock.calls[0]?.[1];
    toastOptions?.onAction?.();

    expect(h.openCodingPlanUpgrade.mock.calls[0]?.[0]?.funnelContext?.eventText).toBe("Upgrade");
  });

  it.each([
    {
      locale: "zh-CN",
      messages: zhCN,
      bannerText: "订阅用户新功能体验：创建“闲时任务”，我们将免费在算力富余时段为你完成指派任务。",
      bannerTipText: "本功能不消耗订阅用户套餐额度、本功能仅面向订阅用户开放",
      fullCopy:
        "订阅用户新功能体验：创建“闲时任务”，我们将免费在算力富余时段为你完成指派任务。本功能不消耗订阅用户套餐额度、本功能仅面向订阅用户开放",
      copySeparator: "",
    },
    {
      locale: "en-US",
      messages: enUS,
      bannerText:
        'New feature for subscribers: Create "Idle-time task" , We will complete your assigned task for free during periods of surplus computing power.',
      bannerTipText:
        "This feature does not consume your subscription plan quota and is available exclusively to subscribers.",
      fullCopy:
        'New feature for subscribers: Create "Idle-time task" , We will complete your assigned task for free during periods of surplus computing power. This feature does not consume your subscription plan quota and is available exclusively to subscribers.',
      copySeparator: " ",
    },
  ])(
    "$locale 首页展示、提示与模板预填使用同一种语言",
    ({ locale, messages, bannerText, bannerTipText, fullCopy, copySeparator }) => {
      h.messages.current = messages;
      h.locale.current = locale;
      h.providerSettingsState.view = {
        revision: 2,
        addableProviders: [],
        providerOrder: [],
        providers: [
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            enabled: true,
            executable: true,
            effectiveConfig: {
              label: "Z.ai Coding Plan",
              access: {
                type: "zhipu-account",
                family: "zai",
                mode: "individual-coding-plan",
                entitled: true,
              },
              api: {
                type: "anthropic-messages",
                baseUrl: "https://example.com",
              },
              builtinModelIds: ["glm-5"],
            },
            issues: [],
            models: [],
          },
        ],
      };

      const copy = h.remoteTemplateCopy.standupGitSummary[locale === "zh-CN" ? "cn" : "en"];
      const { title, description, prompt } = copy;
      const onOpenAutomations = vi.fn();

      render(createElement(OffPeakNewTaskEntry, { onOpenAutomations }));
      const bannerCopy = screen.getByText(bannerText);
      fireEvent.focus(bannerCopy);
      const tipCopies = screen.getAllByText(bannerTipText);
      expect([bannerText, bannerTipText].join(copySeparator)).toBe(fullCopy);
      expect(tipCopies.length).toBeGreaterThan(0);
      expect(
        tipCopies.some(
          (copy) =>
            copy.parentElement?.classList.contains("max-w-none") &&
            copy.parentElement?.classList.contains("whitespace-nowrap"),
        ),
      ).toBe(true);
      const templateCard = screen.getByRole("button", {
        name: `${title} ${description}`,
      });
      fireEvent.click(templateCard);

      expect(h.toast).not.toHaveBeenCalled();
      expect(h.setPendingCreateDraft).toHaveBeenCalledWith({
        title,
        prompt,
        telemetrySource: {
          eventRegion: "app.session",
          templateId: "standupGitSummary",
        },
      });
      expect(onOpenAutomations).toHaveBeenCalledOnce();
    },
  );
});
