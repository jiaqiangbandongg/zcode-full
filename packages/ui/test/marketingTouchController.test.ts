import { describe, expect, it, vi } from "vitest";
import { createMarketingTouchController } from "@/components/marketing-touch/marketingTouchController.js";
import type { MarketingDelivery } from "@zcode/shared";

const text = { format: "plaintext" as const, content: "News" };
const popup = {
  title: text,
  description: text,
  buttons: [{ text, action: { type: "close" as const } }],
};
const banner: MarketingDelivery = {
  campaign_id: "banner",
  resource_position: "banner",
  priority: 1,
  banner: {
    background: {
      type: "image",
      image: { default: { src: "https://cdn.example.com/a.png", sha256: "a".repeat(64) } },
    },
    buttons: [
      { text, action: { type: "close" } },
      { text, action: { type: "claim_zcode_plan", args: { plan_id: "plan" } } },
    ],
    success_popup: popup,
  },
};
const independent: MarketingDelivery = {
  campaign_id: "popup",
  resource_position: "popup",
  priority: 1,
  popup,
};
function fixture(overrides: Partial<Parameters<typeof createMarketingTouchController>[0]> = {}) {
  const report = vi.fn<Parameters<typeof createMarketingTouchController>[0]["report"]>(
    async () => {},
  );
  const execute = vi.fn(async () => ({ status: "success" as const }));
  const prepare = vi.fn(async (delivery: MarketingDelivery) => ({
    delivery,
    image: "data:image/png;base64,a",
    hero: null,
    release: async () => {},
  }));
  const query = vi.fn(async () => ({
    scope: "scope",
    serverTime: 1,
    language: "en-US" as const,
    deliveries: [banner, independent],
    rejectedCount: 0,
  }));
  const controller = createMarketingTouchController({
    query,
    report,
    prepare,
    execute,
    locale: "en-US",
    canOpen: () => true,
    refresh: vi.fn(),
    ...overrides,
  });
  return { controller, report, execute, prepare, query };
}
describe("marketing touch controller", () => {
  it("keeps claim errors for the dialog and acknowledgement never retries or reports", async () => {
    const execute = vi.fn(async () => ({ status: "failure" as const, message: "Server message" }));
    const { controller, report } = fixture({ execute });
    await controller.refresh();
    await controller.clickBanner();
    expect(controller.store.getState()).toMatchObject({
      pending: false,
      error: "Server message",
      errorAction: "claim_zcode_plan",
      dialog: null,
    });
    controller.clearError();
    expect(controller.store.getState()).toMatchObject({ error: null, errorAction: null });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    await controller.showPending();
    expect(controller.store.getState().dialog?.delivery.campaign_id).toBe("popup");
    controller.dispose();
  });
  it("reports a new copy in the claim result without reporting cancel on result close", async () => {
    const f = fixture();
    f.query.mockResolvedValue({
      scope: "scope",
      serverTime: 1,
      language: "en-US",
      deliveries: [banner],
      rejectedCount: 0,
    });
    await f.controller.refresh();
    await f.controller.clickBanner();
    await f.controller.dialogAction({ type: "copy_text", args: { text: "result" } });
    expect(f.controller.store.getState().dialog?.result).toBe(true);
    await f.controller.closeDialog();
    expect(f.report.mock.calls.map(([event]) => event.actionType)).toEqual(["confirm", "confirm"]);
    f.controller.dispose();
  });
  it("retains content after an uncertain clipboard outcome without confirming", async () => {
    const f = fixture({ execute: async () => ({ status: "uncertain", message: "timeout" }) });
    await f.controller.refresh();
    await f.controller.showPending();
    await f.controller.dialogAction({ type: "copy_text", args: { text: "hello" } });
    expect(f.controller.store.getState().dialog).not.toBeNull();
    expect(f.controller.store.getState().pending).toBe(false);
    expect(f.report).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("copies repeatedly, retains the popup, reports each success and subsequent close", async () => {
    const refresh = vi.fn();
    const f = fixture({ refresh });
    await f.controller.refresh();
    await f.controller.showPending();
    const action = { type: "copy_text" as const, args: { text: "hello\nworld" } };
    await f.controller.dialogAction(action);
    await f.controller.dialogAction(action);
    expect(f.controller.store.getState().dialog).not.toBeNull();
    expect(f.report.mock.calls.map(([event]) => event.actionType)).toEqual(["confirm", "confirm"]);
    expect(refresh).not.toHaveBeenCalled();
    await f.controller.closeDialog();
    expect(f.report.mock.calls.map(([event]) => event.actionType)).toEqual([
      "confirm",
      "confirm",
      "cancel",
    ]);
    f.controller.dispose();
  });
  it("returns failed copy outcomes without removing the popup or reporting success", async () => {
    const f = fixture({ execute: async () => ({ status: "failure", message: "failed" }) });
    await f.controller.refresh();
    await f.controller.showPending();
    expect(
      await f.controller.dialogAction({ type: "copy_text", args: { text: "hello" } }),
    ).toMatchObject({ status: "failure" });
    expect(f.controller.store.getState().dialog).not.toBeNull();
    expect(f.report).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it.each(["navigate", "copy_text"] as const)(
    "does not open success_popup for banner %s",
    async (type) => {
      const delivery = structuredClone(banner);
      if (delivery.resource_position !== "banner") throw new Error("fixture");
      delivery.banner.buttons[1]!.action =
        type === "navigate"
          ? { type, args: { page: "settings" } }
          : { type, args: { text: "hello" } };
      const refresh = vi.fn();
      const f = fixture({ refresh });
      f.query.mockResolvedValue({
        scope: "scope",
        serverTime: 1,
        language: "en-US",
        deliveries: [delivery],
        rejectedCount: 0,
      });
      await f.controller.refresh();
      await f.controller.clickBanner();
      expect(f.controller.store.getState().dialog).toBeNull();
      expect(Boolean(f.controller.store.getState().banner)).toBe(type === "copy_text");
      expect(f.report).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      f.controller.dispose();
    },
  );
  it("queues the successful result behind an unrelated modal without releasing its hero", async () => {
    let visible = false;
    const release = vi.fn(async () => {});
    const f = fixture({
      canOpen: () => visible,
      prepare: async (delivery) => ({ delivery, hero: null, release }),
    });
    await f.controller.refresh();
    await f.controller.clickBanner();
    expect(f.controller.store.getState().dialog).toBeNull();
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    visible = true;
    await f.controller.showPending();
    expect(f.controller.store.getState().dialog?.result).toBe(true);
    await f.controller.closeDialog();
    expect(release).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it("restores the close control without reporting when the action is cancelled", async () => {
    const f = fixture({ execute: async () => ({ status: "cancelled" }) });
    f.query.mockResolvedValue({
      scope: "scope",
      serverTime: 1,
      language: "en-US",
      deliveries: [banner],
      rejectedCount: 0,
    });
    await f.controller.refresh();
    await f.controller.clickBanner();
    expect(f.controller.store.getState()).toMatchObject({
      pending: false,
      phase: "idle",
      dialog: null,
    });
    expect(f.controller.store.getState().banner?.delivery.campaign_id).toBe("banner");
    expect(f.report).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("keeps the clicked snapshot while a refresh prepares the next banner", async () => {
    let resolve!: (value: { status: "cancelled" }) => void;
    const f = fixture({
      execute: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await f.controller.refresh();
    const operation = f.controller.clickBanner();
    await Promise.resolve();
    f.query.mockResolvedValue({
      scope: "scope",
      serverTime: 1,
      language: "en-US",
      deliveries: [{ ...banner, campaign_id: "next" }],
      rejectedCount: 0,
    });
    await f.controller.refresh();
    expect(f.controller.store.getState().banner?.delivery.campaign_id).toBe("banner");
    resolve({ status: "cancelled" });
    await operation;
    expect(f.controller.store.getState().banner?.delivery.campaign_id).toBe("next");
    expect(f.report).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("waits for another modal without remembering a shown campaign", async () => {
    let visible = false;
    const f = fixture({ canOpen: () => visible });
    await f.controller.refresh();
    await f.controller.showPending();
    expect(f.controller.store.getState().dialog).toBeNull();
    visible = true;
    await f.controller.showPending();
    expect(f.controller.store.getState().dialog?.delivery.campaign_id).toBe("popup");
    f.controller.dispose();
  });
  it("reports each independent close and allows the server to redeliver the same popup", async () => {
    const f = fixture();
    await f.controller.refresh();
    await f.controller.showPending();
    expect(f.controller.store.getState().dialog?.delivery.campaign_id).toBe("popup");
    await f.controller.closeDialog();
    await f.controller.closeDialog();
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.report.mock.calls[0]?.[0]).toMatchObject({
      campaignId: "popup",
      actionType: "cancel",
    });
    expect(f.controller.store.getState().banner).toBeTruthy();
    await f.controller.refresh();
    await f.controller.showPending();
    expect(f.controller.store.getState().dialog?.delivery.campaign_id).toBe("popup");
    await f.controller.closeDialog();
    expect(f.report).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });
  it("shows and reports the same banner again after closing it", async () => {
    const f = fixture();
    await f.controller.refresh();
    await f.controller.closeBanner();
    await f.controller.closeBanner();
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.controller.store.getState().banner).toBeNull();
    await f.controller.refresh();
    expect(f.controller.store.getState().banner?.delivery.campaign_id).toBe("banner");
    await f.controller.closeBanner();
    expect(f.report).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });
  it("allows the same banner to be acted on and reported after a successful previous delivery", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      await f.controller.refresh();
      expect(f.controller.store.getState().banner).not.toBeNull();
      await f.controller.clickBanner();
      expect(f.controller.store.getState().banner).toBeNull();
      await f.controller.closeDialog();
    }
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.report).toHaveBeenCalledTimes(2);
    expect(f.report.mock.calls.every(([event]) => event.actionType === "confirm")).toBe(true);
    f.controller.dispose();
  });
  it("does not queue the currently open popup again from background polls", async () => {
    const f = fixture();
    await f.controller.refresh();
    await f.controller.showPending();
    const dialog = f.controller.store.getState().dialog;
    await f.controller.refresh();
    await f.controller.showPending();
    expect(f.controller.store.getState().dialog).toBe(dialog);
    await f.controller.closeDialog();
    await f.controller.showPending();
    expect(f.controller.store.getState().dialog).toBeNull();
    f.controller.dispose();
  });
  it("disbanners a query started before close but accepts a subsequent query", async () => {
    const f = fixture();
    await f.controller.refresh();
    let resolve!: (value: Awaited<ReturnType<typeof f.query>>) => void;
    f.query.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const inFlight = f.controller.refresh();
    await f.controller.closeBanner();
    resolve({
      scope: "scope",
      serverTime: 1,
      language: "en-US",
      deliveries: [banner],
      rejectedCount: 0,
    });
    await inFlight;
    expect(f.controller.store.getState().banner).toBeNull();
    await f.controller.refresh();
    expect(f.controller.store.getState().banner).not.toBeNull();
    f.controller.dispose();
  });
  it("locks repeated banner clicks and does not cancel-report the success dialog", async () => {
    const f = fixture();
    f.query.mockResolvedValue({
      scope: "scope",
      serverTime: 1,
      language: "en-US",
      deliveries: [banner],
      rejectedCount: 0,
    });
    let resolve!: (value: { status: "success" }) => void;
    f.execute.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await f.controller.refresh();
    const operation = f.controller.clickBanner();
    void f.controller.clickBanner();
    expect(f.controller.store.getState().pending).toBe(true);
    await Promise.resolve();
    resolve({ status: "success" });
    await operation;
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.controller.store.getState().dialog?.result).toBe(true);
    await f.controller.closeDialog();
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.report.mock.calls[0]?.[0]).toMatchObject({
      campaignId: "banner",
      actionType: "confirm",
    });
    f.controller.dispose();
  });
  it("disbanners resources that finish after disposal", async () => {
    const f = fixture();
    const release = vi.fn(async () => {});
    let resolve!: (value: Awaited<ReturnType<typeof f.prepare>>) => void;
    f.prepare.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.query.mockResolvedValue({
      scope: "scope",
      serverTime: 1,
      language: "en-US",
      deliveries: [banner],
      rejectedCount: 0,
    });
    const refresh = f.controller.refresh();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.dispose();
    resolve({ delivery: banner, image: "", hero: null, release });
    await refresh;
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.controller.store.getState().banner).toBeNull();
  });
  it("releases resources prepared before a close instead of reviving the dismissed banner", async () => {
    const f = fixture();
    await f.controller.refresh();
    const release = vi.fn(async () => {});
    let resolve!: (value: Awaited<ReturnType<typeof f.prepare>>) => void;
    f.prepare.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.query.mockResolvedValue({
      scope: "scope",
      serverTime: 1,
      language: "en-US",
      rejectedCount: 0,
      deliveries: [{ ...banner, priority: 2 }],
    });
    // 正在显示 Popup 的关闭同样必须使此前启动的资源准备失效。
    await f.controller.showPending();
    const inFlight = f.controller.refresh();
    await Promise.resolve();
    await f.controller.closeDialog();
    resolve({ delivery: banner, image: "", hero: null, release });
    await inFlight;
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.controller.store.getState().banner).toBeNull();
    f.controller.dispose();
  });
  it("drops pre-success deferred content without blacklisting its campaign", async () => {
    let resolve!: (value: { status: "success" }) => void;
    const f = fixture({
      execute: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await f.controller.refresh();
    const operation = f.controller.clickBanner();
    f.query.mockResolvedValue({
      scope: "scope",
      serverTime: 1,
      language: "en-US",
      rejectedCount: 0,
      deliveries: [{ ...banner, priority: 2 }],
    });
    await f.controller.refresh();
    resolve({ status: "success" });
    await operation;
    expect(f.controller.store.getState().banner).toBeNull();
    await f.controller.closeDialog();
    await f.controller.refresh();
    expect(f.controller.store.getState().banner?.delivery.priority).toBe(2);
    f.controller.dispose();
  });
});
