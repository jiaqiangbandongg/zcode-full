// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_HERO_MESSAGE_CHANNEL,
  CloudDialogHero,
  isTrustedCloudHeroMessage,
} from "@/components/cloud-content-dialog/CloudDialogHero.js";
import { createWeekendPlanResultDialogMock } from "./helpers/weekendPlanDialogFixture.js";

const mockInput = {
  locale: "zh-CN" as const,
  planName: "Weekend Plan",
  amountLabel: "300,000,000 Tokens",
  benefits: ["GLM-5.3-Flash 每日额度"],
  endsAtLabel: "2026年9月4日 23:59",
  title: "Weekend Plan 领取成功",
  description: "GLM-5.3-Flash 已可使用。",
  replayLabel: "重新播放票券动画",
  confirmLabel: "模型设置",
  shareLabel: "复制分享",
  shareText: "Weekend Plan 分享内容",
};

afterEach(() => cleanup());

describe("CloudDialogHero", () => {
  it("drops undeclared actions and falls back when ready times out", () => {
    vi.useFakeTimers();
    try {
      const payload = createWeekendPlanResultDialogMock(mockInput);
      const onAction = vi.fn();
      render(
        createElement(CloudDialogHero, {
          hero: payload.dialog.hero,
          locale: "en-US",
          title: "Timeout hero",
          onAction,
        }),
      );
      const frame = screen.getByTitle("Timeout hero") as HTMLIFrameElement;
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source: frame.contentWindow,
            data: {
              channel: CLOUD_HERO_MESSAGE_CHANNEL,
              instanceId: frame.dataset.instanceId,
              type: "action",
              id: "claim-plan",
            },
          }),
        ),
      );
      expect(onAction).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(5_001));
      expect(screen.queryByTestId("cloud-dialog-interactive-hero")).toBeNull();
      expect(screen.getByTestId("cloud-dialog-hero-error")).toBeTruthy();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
  it("用无同源权限的 iframe 加载交互资源并发送初始化数据", () => {
    const payload = createWeekendPlanResultDialogMock(mockInput);
    render(
      createElement(CloudDialogHero, {
        hero: payload.dialog.hero,
        locale: "zh-CN",
        title: "Weekend Hero",
      }),
    );

    const frame = screen.getByTitle("Weekend Hero") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.dataset.heroType).toBe("interactive_bundle");
    expect(frame.dataset.status).toBe("loading");

    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: CLOUD_HERO_MESSAGE_CHANNEL,
        type: "init",
        locale: "zh-CN",
        data: expect.objectContaining({ planName: "Weekend Plan" }),
      }),
      "*",
    );
  });

  it("只接受当前 iframe 与 instanceId 对应的 ready 消息", async () => {
    const payload = createWeekendPlanResultDialogMock(mockInput);
    render(
      createElement(CloudDialogHero, {
        hero: payload.dialog.hero,
        locale: "zh-CN",
        title: "Weekend Hero",
      }),
    );
    const frame = screen.getByTitle("Weekend Hero") as HTMLIFrameElement;
    const instanceId = frame.dataset.instanceId!;

    expect(
      isTrustedCloudHeroMessage(
        {
          source: frame.contentWindow,
          data: {
            channel: CLOUD_HERO_MESSAGE_CHANNEL,
            type: "ready",
            instanceId: "stale-instance",
          },
        },
        frame.contentWindow,
        instanceId,
      ),
    ).toBe(false);
    expect(
      isTrustedCloudHeroMessage(
        {
          source: frame.contentWindow,
          data: {
            channel: CLOUD_HERO_MESSAGE_CHANNEL,
            type: "ready",
            instanceId,
          },
        },
        frame.contentWindow,
        instanceId,
      ),
    ).toBe(true);

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          channel: CLOUD_HERO_MESSAGE_CHANNEL,
          type: "ready",
          instanceId,
        },
      }),
    );
    await waitFor(() => expect(frame.dataset.status).toBe("ready"));
  });
});
