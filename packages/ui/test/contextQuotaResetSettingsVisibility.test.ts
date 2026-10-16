// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { type TabStore } from "@/store/tabStore.js";

const state = vi.hoisted(() => ({
  phase: "initial" as "initial" | "urgent" | null,
  dismiss: vi.fn(),
}));
vi.mock("@/chat-input-toolbar/contextQuotaResetOpportunityReminder.js", async (original) => ({
  ...(await original<object>()),
  resolveContextQuotaResetOpportunityReminder: () =>
    state.phase && { count: 1, phase: state.phase, opportunityKey: "test", remainingSeconds: 120 },
  contextQuotaResetOpportunityDismissalStore: {
    subscribe: () => () => {},
    getSnapshot: () => null,
    dismiss: state.dismiss,
  },
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    title,
    open,
  }: {
    children: ReactNode;
    title: ReactNode;
    open: boolean;
  }) => createElement("div", null, children, open ? createPortal(title, document.body) : null),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));
afterEach(() => {
  cleanup();
  state.dismiss.mockClear();
  state.phase = "initial";
});

it.each(["initial", "urgent"] as const)(
  "hides %s portals without consuming reminders while settings is active",
  (phase) => {
    state.phase = phase;
    let store: TabStore;
    function Probe() {
      store = useTabStoreApi();
      return null;
    }
    const view = () =>
      createElement(
        TabStoreProvider,
        null,
        createElement(Probe),
        createElement(ChatContextUsage, {
          intl: { formatMessage: ({ id }: { id: string }) => id } as never,
          locale: "en-US",
          selectedProvider: "glm",
          taskUsage: { used: 1, size: 100 },
        }),
      );
    const rendered = render(view());
    const query = () => document.querySelector(`[data-context-reset-reminder="${phase}"]`);
    expect(query()).not.toBeNull();
    const trigger = screen.getByRole("button", { name: "chat.contextUsage" });
    let workspaceId: string;
    act(() => {
      workspaceId = store!.getState().addTab("/workspace");
      store!.getState().openSettingsTab();
    });
    expect(query()).toBeNull();
    fireEvent.pointerDown(document.body);
    expect(state.dismiss).not.toHaveBeenCalled();
    // 设置期间新机会到达也不能打开 Portal。
    state.phase = null;
    rendered.rerender(view());
    state.phase = phase;
    rendered.rerender(view());
    expect(query()).toBeNull();
    act(() => store!.getState().activateTab(workspaceId!));
    expect(query()).not.toBeNull();
    expect(screen.getByRole("button", { name: "chat.contextUsage" })).toBe(trigger);
    fireEvent.pointerDown(document.body);
    expect(state.dismiss).toHaveBeenCalledTimes(1);
  },
);
