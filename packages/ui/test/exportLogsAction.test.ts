import { beforeEach, describe, expect, it, vi } from "vitest";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";

const toastMock = vi.hoisted(() => vi.fn(() => 7));
const dismissToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui/toast.js", () => ({
  toast: toastMock,
  dismissToast: dismissToastMock,
}));

const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    values?.error ? `${id}:${values.error}` : id,
};

describe("runExportLogsAction", () => {
  beforeEach(() => {
    toastMock.mockClear();
    dismissToastMock.mockClear();
  });

  it("keeps the pending toast open until export finishes", async () => {
    const exportLogs = vi.fn(async () => ({ success: true }));

    await runExportLogsAction({ exportLogs }, intl);

    expect(exportLogs).toHaveBeenCalledOnce();
    expect(toastMock).toHaveBeenCalledWith("sidebar.exportLogs.pending", {
      durationMs: Number.POSITIVE_INFINITY,
    });
    expect(dismissToastMock).toHaveBeenCalledWith(7);
  });

  it("shows the platform error when export fails", async () => {
    const exportLogs = vi.fn(async () => ({
      success: false,
      error: "not supported",
    }));

    await runExportLogsAction({ exportLogs }, intl);

    expect(exportLogs).toHaveBeenCalledOnce();
    expect(toastMock).toHaveBeenCalledWith("sidebar.exportLogs.error:not supported");
    expect(dismissToastMock).toHaveBeenCalledWith(7);
  });
});
