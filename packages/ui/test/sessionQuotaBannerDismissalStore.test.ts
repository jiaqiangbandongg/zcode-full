import { describe, expect, it } from "vitest";
import { createSessionQuotaBannerDismissalStore } from "@/v4/sessionQuotaBannerDismissalStore.js";

describe("session quota banner dismissal store", () => {
  it("keeps dismissal per session across consumers", () => {
    const store = createSessionQuotaBannerDismissalStore(4);
    store.dismiss("session-a", "failure-1");
    expect(store.isDismissed("session-a", "failure-1")).toBe(true);
    expect(store.isDismissed("session-b", "failure-1")).toBe(false);
  });

  it("new failure keys remain visible and entries are bounded", () => {
    const store = createSessionQuotaBannerDismissalStore(2);
    store.dismiss("session-a", "failure-1");
    expect(store.isDismissed("session-a", "failure-2")).toBe(false);
    store.dismiss("session-b", "failure-1");
    store.dismiss("session-c", "failure-1");
    expect(store.isDismissed("session-a", "failure-1")).toBe(false);
    expect(store.isDismissed("session-b", "failure-1")).toBe(true);
    expect(store.isDismissed("session-c", "failure-1")).toBe(true);
  });

  it("notifies subscribers only for a new dismissal", () => {
    const store = createSessionQuotaBannerDismissalStore(4);
    let notifications = 0;
    const dispose = store.subscribe(() => {
      notifications += 1;
    });
    store.dismiss("session-a", "failure-1");
    store.dismiss("session-a", "failure-1");
    dispose();
    expect(notifications).toBe(1);
  });
});
