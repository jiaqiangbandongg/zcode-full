import { beforeEach, describe, expect, it } from "vitest";
import { useAlertDialogStore } from "@/store/alertDialogStore.js";

describe("alertDialogStore", () => {
  beforeEach(() => {
    useAlertDialogStore.setState({ pendingRequest: undefined });
  });

  it("returns false when a concurrent alert is dropped", async () => {
    const first = useAlertDialogStore.getState().requestAlert({ title: "first" });
    const second = await useAlertDialogStore.getState().requestAlert({ title: "second" });

    expect(second).toBe(false);
    useAlertDialogStore.getState().settleAlert();
    await expect(first).resolves.toBe(true);
  });

  it("returns false when the dialog is closed without confirmation", async () => {
    const request = useAlertDialogStore.getState().requestAlert({ title: "close" });

    useAlertDialogStore.getState().settleAlert(false);

    await expect(request).resolves.toBe(false);
  });
});
