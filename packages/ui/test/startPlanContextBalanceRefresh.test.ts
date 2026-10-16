// @vitest-environment jsdom
// 修复原因：Start Plan 今日余额原先没有 hover 刷新入口（onAccess 只挂在 Coding Plan 配置上，
// 两段互斥导致 start plan 用户 hover 时整条刷新链路不触发），也没有跟随 hover promise 的
// loading 反馈。本文件锁定补齐后的三条语义：hover 触发、refreshing spinner、触发器兜底。

import { createElement, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  ChatStartPlanBalancePanel,
  hasChatStartPlanBalance,
} from "../src/chat-input-toolbar/StartPlanContextBalance.js";
import { ChatContextUsage } from "../src/chat-input-toolbar/contextUsage.js";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../src/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("../src/CodingPlanBillingDiscount.js", () => ({
  CodingPlanBillingDiscountBadgePill: () => "billing-discount-badge",
  CodingPlanBillingDiscountInfoDialog: () => "billing-discount-info",
  useCodingPlanBillingDiscount: () => ({ active: false, loading: false }),
}));

vi.mock("@/components/ai-elements/context.js", async () => {
  const React = await import("react");
  const passthrough =
    (tag: "button" | "div") =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(tag, props, children);

  return {
    Context: ({
      children,
      onOpenChange,
    }: {
      children?: React.ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) =>
      React.createElement("div", {}, [
        React.createElement(
          "button",
          {
            key: "open",
            "data-testid": "context-open",
            onClick: () => onOpenChange?.(true),
          },
          "open",
        ),
        React.createElement(
          "button",
          {
            key: "close",
            "data-testid": "context-close",
            onClick: () => onOpenChange?.(false),
          },
          "close",
        ),
        React.createElement(React.Fragment, { key: "children" }, children),
      ]),
    ContextContent: passthrough("div"),
    ContextContentBody: passthrough("div"),
    ContextTrigger: passthrough("button"),
  };
});

afterEach(() => {
  cleanup();
});

function createStartPlanSnapshot(): NonNullable<
  ComponentProps<typeof ChatStartPlanBalancePanel>["config"]["snapshot"]
> {
  return {
    generatedAt: 1,
    authenticated: true,
    provider: {
      id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      name: "Z.ai Start Plan",
    },
    remaining: null,
    subscription: null,
    quota: {
      level: "Start",
      limits: [
        {
          type: "TOKENS_LIMIT",
          number: 1_000_000,
          remaining: 750_000,
          usageDetails: [
            {
              modelCode: "glm-5.2",
              displayName: "GLM-5.2",
              usage: 250_000,
            },
          ],
        },
      ],
    },
  };
}

function createIntl(): ComponentProps<typeof ChatContextUsage>["intl"] {
  return {
    formatMessage: ({ id }: { id: string }) => id,
  } as never;
}

describe("hasChatStartPlanBalance hover 入口兜底", () => {
  it("无缓存快照且未 loading 时，onAccess 存在仍保留触发器", () => {
    expect(hasChatStartPlanBalance({ loading: false, snapshot: null })).toBe(false);
    expect(
      hasChatStartPlanBalance({
        loading: false,
        snapshot: null,
        onAccess: vi.fn(),
      }),
    ).toBe(true);
  });
});

describe("ChatStartPlanBalancePanel refreshing spinner", () => {
  const baseProps = {
    intl: createIntl(),
    locale: "en-US",
  } satisfies Partial<ComponentProps<typeof ChatStartPlanBalancePanel>>;

  it("静默 hover 刷新（refreshing）时即使 loading=false 也显示 spinner", () => {
    const html = renderToStaticMarkup(
      createElement(ChatStartPlanBalancePanel, {
        ...baseProps,
        config: {
          loading: false,
          refreshing: true,
          snapshot: createStartPlanSnapshot(),
        },
      }),
    );

    expect(html).toContain("settings.modelProvider.startPlan.balance.title");
    expect(html).toContain("animate-spin");
  });

  it("无刷新进行中时不显示 spinner", () => {
    const html = renderToStaticMarkup(
      createElement(ChatStartPlanBalancePanel, {
        ...baseProps,
        config: {
          loading: false,
          snapshot: createStartPlanSnapshot(),
        },
      }),
    );

    expect(html).not.toContain("animate-spin");
  });
});

describe("ChatContextUsage start plan hover 刷新", () => {
  it("只有 startPlanBalance.onAccess 时 hover 打开触发一次静默刷新，关闭不触发", async () => {
    let resolveAccess!: () => void;
    const onAccess = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAccess = resolve;
        }),
    );

    render(
      createElement(ChatContextUsage, {
        startPlanBalance: {
          loading: false,
          onAccess,
          snapshot: createStartPlanSnapshot(),
        },
        intl: createIntl(),
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: null,
      }),
    );

    expect(document.querySelector(".animate-spin")).toBeNull();

    fireEvent.click(screen.getByTestId("context-open"));

    expect(onAccess).toHaveBeenCalledTimes(1);
    // hover 触发的静默刷新进行中：spinner 跟随本次 promise，而不是 entitlement.loading。
    expect(document.querySelector(".animate-spin")).not.toBeNull();

    await act(async () => {
      resolveAccess();
    });

    expect(document.querySelector(".animate-spin")).toBeNull();

    fireEvent.click(screen.getByTestId("context-close"));

    expect(onAccess).toHaveBeenCalledTimes(1);
  });

  it("Coding Plan 与 Start Plan 同时提供 onAccess 时互斥只触发 Coding Plan 一侧", () => {
    const codingPlanOnAccess = vi.fn();
    const startPlanOnAccess = vi.fn();

    render(
      createElement(ChatContextUsage, {
        codingPlanUsageRemaining: {
          availableProviders: [],
          entitlements: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              snapshot: null,
              loading: false,
              error: null,
            },
          ],
          modelProvidersLoading: false,
          onAccess: codingPlanOnAccess,
        },
        startPlanBalance: {
          loading: false,
          onAccess: startPlanOnAccess,
          snapshot: createStartPlanSnapshot(),
        },
        intl: createIntl(),
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: null,
      }),
    );

    fireEvent.click(screen.getByTestId("context-open"));

    expect(codingPlanOnAccess).toHaveBeenCalledTimes(1);
    expect(startPlanOnAccess).not.toHaveBeenCalled();
  });
});
