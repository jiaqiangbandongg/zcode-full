import { describe, expect, it, vi } from "vitest";

import { flushElectronStorageData } from "./e2e/helpers/e2e-electron-storage.js";

describe("desktop e2e Electron storage", () => {
  it("flushes every distinct Chromium session on every invocation", async () => {
    const firstSession = { flushStorageData: vi.fn(async () => undefined) };
    const secondSession = { flushStorageData: vi.fn(async () => undefined) };
    const electron = {
      BrowserWindow: {
        getAllWindows: () => [
          { webContents: { session: firstSession } },
          { webContents: { session: firstSession } },
          { webContents: { session: secondSession } },
        ],
      },
    };
    const execute = vi.fn(async (callback: (runtime: typeof electron) => Promise<void>) =>
      callback(electron),
    );
    const browser = { electron: { execute } };

    await flushElectronStorageData(browser as never);
    await flushElectronStorageData(browser as never);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(firstSession.flushStorageData).toHaveBeenCalledTimes(2);
    expect(secondSession.flushStorageData).toHaveBeenCalledTimes(2);
  });
});
