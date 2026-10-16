// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";

const h = vi.hoisted(() => ({
  entryPlanList: "coding_plan__personal_lite,start_plan__start",
  status: "ready" as "ready" | "loading" | "error",
  retry: vi.fn(),
  reportTelemetryEvent: vi.fn().mockResolvedValue(undefined),
  renderedTargets: [] as Array<
    | {
        providerId: string;
        initialAudience?: "personal" | "team";
        funnelContext?: CodingPlanFunnelContext;
      }
    | undefined
  >,
  onOpenResult: undefined as undefined | ((opened: boolean) => void),
}));

vi.mock("@/hooks/useCodingPlanEntryPlanList.js", () => ({
  useCodingPlanEntryPlanList: () => ({
    entryPlanList: h.entryPlanList,
    status: h.status,
    retry: h.retry,
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ reportTelemetryEvent: h.reportTelemetryEvent }),
}));

vi.mock("@/settings/CodingPlanUpgradeDialog.js", () => ({
  CodingPlanUpgradeDialog: ({
    target,
    onOpenResult,
  }: {
    onOpenResult?: (opened: boolean) => void;
    target?: {
      providerId: string;
      initialAudience?: "personal" | "team";
      funnelContext?: CodingPlanFunnelContext;
    };
  }) => {
    h.renderedTargets.push(target);
    h.onOpenResult = onOpenResult;
    return null;
  },
}));

import {
  CodingPlanUpgradeDialogProvider,
  useCodingPlanUpgradeDialog,
} from "@/settings/CodingPlanUpgradeDialogProvider.js";

const funnelContext: CodingPlanFunnelContext = {
  purchaseFunnelId: "idle-funnel-login",
  upgradeSource: "session_idle_time",
  eventRegion: "app.session",
  eventText: "Upgrade",
  entryPlanStatus: "no_plan",
  entryPlanLevel: "",
  entryPlanList: "",
  purchaseAudience: "personal",
  providerFamily: "zai",
  channel: "Z_AI",
};

function Launcher({ loginVersion }: { loginVersion: number }) {
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  return createElement(
    "button",
    {
      type: "button",
      "data-login-version": loginVersion,
      onClick: () =>
        openCodingPlanUpgrade({
          providerId: "zai-coding-plan",
          initialAudience: "personal",
          funnelContext,
        }),
    },
    "Upgrade",
  );
}

afterEach(() => {
  cleanup();
  h.status = "ready";
  h.reportTelemetryEvent.mockClear();
  h.renderedTargets.length = 0;
});

describe("CodingPlanUpgradeDialogProvider", () => {
  it.each([true, false])("observes opening result %s once", (opened) => {
    const result = vi.fn();
    function ObservedLauncher() {
      const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
      return createElement(
        "button",
        {
          onClick: () =>
            openCodingPlanUpgrade(
              { providerId: "builtin:bigmodel-coding-plan" },
              { signal: new AbortController().signal, onResult: result },
            ),
        },
        "Observed",
      );
    }
    render(createElement(CodingPlanUpgradeDialogProvider, null, createElement(ObservedLauncher)));
    fireEvent.click(screen.getByText("Observed"));
    expect(result).not.toHaveBeenCalled();
    h.onOpenResult?.(opened);
    h.onOpenResult?.(opened);
    expect(result).toHaveBeenCalledExactlyOnceWith(opened);
  });
  it("aborts an observed opening and ignores late ready", () => {
    const signal = new AbortController();
    const result = vi.fn();
    function ObservedLauncher() {
      const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
      return createElement(
        "button",
        {
          onClick: () =>
            openCodingPlanUpgrade(
              { providerId: "builtin:bigmodel-coding-plan" },
              { signal: signal.signal, onResult: result },
            ),
        },
        "Observed",
      );
    }
    render(createElement(CodingPlanUpgradeDialogProvider, null, createElement(ObservedLauncher)));
    fireEvent.click(screen.getByText("Observed"));
    signal.abort();
    h.onOpenResult?.(true);
    expect(result).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(["loading", "error"] as const)("blocks direct calls while inventory is %s", (status) => {
    h.status = status;
    const view = render(
      createElement(
        CodingPlanUpgradeDialogProvider,
        null,
        createElement(Launcher, { loginVersion: 0 }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(h.renderedTargets.at(-1)).toBeUndefined();
    expect(h.reportTelemetryEvent).not.toHaveBeenCalled();
    h.status = "ready";
    view.rerender(
      createElement(
        CodingPlanUpgradeDialogProvider,
        null,
        createElement(Launcher, { loginVersion: 1 }),
      ),
    );
    expect(h.reportTelemetryEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(h.reportTelemetryEvent).toHaveBeenCalledTimes(1);
  });

  it("opens the dialog even when the telemetry request fails", async () => {
    h.reportTelemetryEvent.mockRejectedValueOnce(new Error("offline"));
    render(
      createElement(
        CodingPlanUpgradeDialogProvider,
        null,
        createElement(Launcher, { loginVersion: 0 }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(h.renderedTargets.at(-1)?.funnelContext).toEqual({
      ...funnelContext,
      entryPlanList: h.entryPlanList,
    });
    await waitFor(() => expect(h.reportTelemetryEvent).toHaveBeenCalledTimes(1));
  });

  it("freezes the owned list until the next explicit click", () => {
    const initialList = h.entryPlanList;
    const view = render(
      createElement(
        CodingPlanUpgradeDialogProvider,
        null,
        createElement(Launcher, { loginVersion: 0 }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    h.entryPlanList = "coding_plan__personal_pro";
    view.rerender(
      createElement(
        CodingPlanUpgradeDialogProvider,
        null,
        createElement(Launcher, { loginVersion: 1 }),
      ),
    );
    expect(h.renderedTargets.at(-1)?.funnelContext?.entryPlanList).toBe(initialList);
    expect(h.reportTelemetryEvent).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(h.renderedTargets.at(-1)?.funnelContext?.entryPlanList).toBe(h.entryPlanList);
    expect(funnelContext.entryPlanList).toBe("");
    h.entryPlanList = initialList;
  });

  it("keeps the idle-time funnel target when OAuth login rerenders the app", () => {
    const view = render(
      createElement(
        CodingPlanUpgradeDialogProvider,
        null,
        createElement(Launcher, { loginVersion: 0 }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(h.renderedTargets.at(-1)?.funnelContext).toEqual({
      ...funnelContext,
      entryPlanList: h.entryPlanList,
    });
    expect(h.reportTelemetryEvent).toHaveBeenCalledExactlyOnceWith({
      context: expect.any(Object),
      elementName: "coding_plan_upgrade_ck",
      eventType: "ck",
      eventRegion: "app.session",
      eventText: "Upgrade",
      eventExtraDetail: {
        purchase_funnel_id: "idle-funnel-login",
        upgrade_source: "session_idle_time",
        entry_plan_status: "no_plan",
        entry_plan_level: "",
        entry_plan_list: h.entryPlanList,
        purchase_audience: "personal",
        provider_family: "zai",
        channel: "Z_AI",
      },
    });

    // OAuth callback 会刷新用户与购买凭据并触发 Root 重渲染，但不应重建 provider。
    view.rerender(
      createElement(
        CodingPlanUpgradeDialogProvider,
        null,
        createElement(Launcher, { loginVersion: 1 }),
      ),
    );

    expect(h.renderedTargets.at(-1)).toEqual({
      providerId: "zai-coding-plan",
      initialAudience: "personal",
      funnelContext: { ...funnelContext, entryPlanList: h.entryPlanList },
    });
    expect(h.renderedTargets.at(-1)?.funnelContext?.purchaseFunnelId).toBe("idle-funnel-login");
    expect(h.renderedTargets.at(-1)?.funnelContext?.upgradeSource).toBe("session_idle_time");
    expect(h.reportTelemetryEvent).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(h.reportTelemetryEvent).toHaveBeenCalledTimes(2);
  });
});
