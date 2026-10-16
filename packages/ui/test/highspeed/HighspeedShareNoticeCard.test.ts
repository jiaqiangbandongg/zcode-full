// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalNoticeEnvelope } from "@/global-notice/globalNoticeStore.js";
import { HighspeedShareNoticeCard } from "@/highspeed/HighspeedShareNoticeCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const notice: GlobalNoticeEnvelope = {
  noticeId: "notice-1",
  dedupeKey: "highspeed-share:latest",
  type: "highspeed-share",
  schemaVersion: 1,
  scope: "user",
  priority: "normal",
  interruptPolicy: "passive",
  createdAt: 1,
  expiresAt: 10_000,
  payload: {
    cardId: "hsc-1",
    tokenUsage: 120_000,
    durationMs: 600_000,
    savedDurationMs: 480_000,
  },
  actions: [],
  dismissPolicy: { kind: "cooldown", cooldownMs: 86_400_000 },
  persistencePolicy: "latest-only",
  source: "highspeed",
  revision: 1,
};

afterEach(() => cleanup());

function renderCard(target: GlobalNoticeEnvelope) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(HighspeedShareNoticeCard, { notice: target, onDismiss: vi.fn() }),
    ),
  );
}

describe("HighspeedShareNoticeCard", () => {
  it("renders the compact card and opens the local share dialog", () => {
    const { container, getByRole } = renderCard(notice);
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "View" }));
    expect(getByRole("button", { name: "Copy image" })).toBeTruthy();
    expect(document.querySelector(".highspeed-share-dialog__benefit")).not.toBeNull();
    expect(document.querySelector(".highspeed-share-dialog__chart-bars--baseline")).not.toBeNull();
    expect(document.querySelector(".highspeed-share-dialog__chart-bars--fast")).not.toBeNull();
    expect(document.body.textContent).toContain("I used the ZCode Highspeed card and saved 480s.");
    expect(document.body.textContent).toContain("https://zcode.z.ai");
    expect(document.querySelector('[data-highspeed-share-dialog-card="true"]')).not.toBeNull();
    // Bug 回归锁：Electron 窗口不可见时 animationend 永不触发，Radix 会因等退出动画
    // 卡住不卸载 overlay（bg-black/60 遮罩滞留吞点击）。关闭态必须无动画以同步卸载：
    // overlay/content 必须挂上 highspeed 钩子类，且 CSS 对关闭态强制 animation none。
    expect(document.querySelector('[data-slot="dialog-overlay"]')?.className).toContain(
      "highspeed-share-dialog__overlay",
    );
    expect(document.querySelector('[data-slot="dialog-content"]')?.className).toContain(
      "highspeed-share-dialog__content",
    );
    const shareCss = readFileSync("packages/ui/src/highspeed/highspeed-share.css", "utf8");
    expect(shareCss).not.toMatch(
      /@media \(max-width: 480px\)[\s\S]*?\.highspeed-share-dialog__card\s*\{[^}]*border-radius:\s*16px/,
    );
    expect(shareCss.replace(/\s+/g, " ")).toContain(
      '.highspeed-share-dialog__overlay[data-state="closed"], .highspeed-share-dialog__content[data-state="closed"] { animation: none !important; }',
    );
    expect(shareCss).toContain(".highspeed-share-dialog__url:hover svg");
  });

  it("keeps the card visible but hides View when speedup is not greater than 1.2x", () => {
    // 纵深防御：发布门禁不会放出 ≤1.2x 的卡，这里锁的是不可信/遗留数据不得进入分享弹窗。
    const lowSpeedupNotice: GlobalNoticeEnvelope = {
      ...notice,
      payload: { ...notice.payload, savedDurationMs: 120_000 },
    };
    const { container, queryByRole } = renderCard(lowSpeedupNotice);
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).not.toBeNull();
    expect(queryByRole("button", { name: "View" })).toBeNull();
  });

  it("renders View for a boundary card that only clears 1.2x at millisecond precision", () => {
    // Bug 回归（spec §9）：发布门禁按毫秒判定 7325/6100≈1.2008 > 1.2 而发布；旧 payload 只带
    // 秒级取整值，渲染侧由 ceil(7s)/round(1s) 重建成 8/7≈1.14 ≤ 1.2 → View 被隐藏，
    // 出现“有卡片、无入口”的半残卡。渲染侧必须复用与门禁同精度的毫秒字段复检。
    const boundaryNotice: GlobalNoticeEnvelope = {
      ...notice,
      payload: { cardId: "hsc-edge", tokenUsage: 1_000, durationMs: 6_100, savedDurationMs: 1_225 },
    };
    const { container, getByRole } = renderCard(boundaryNotice);
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).not.toBeNull();
    expect(getByRole("button", { name: "View" })).toBeTruthy();
  });

  it("still renders legacy second-precision payloads persisted before the millisecond fields", () => {
    const legacyNotice: GlobalNoticeEnvelope = {
      ...notice,
      payload: {
        cardId: "hsc-legacy",
        tokenUsage: 120_000,
        durationSeconds: 600,
        savedDurationSeconds: 480,
      },
    };
    const { container, getByRole } = renderCard(legacyNotice);
    expect(container.querySelector('[data-global-notice-type="highspeed-share"]')).not.toBeNull();
    expect(getByRole("button", { name: "View" })).toBeTruthy();
  });
});
