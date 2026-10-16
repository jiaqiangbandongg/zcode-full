import { describe, expect, it, vi } from "vitest";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import {
  connectProviderSettingsSnapshot,
  getProviderSettingsSnapshot,
  resetProviderSettingsSnapshotForTest,
} from "@/lib/providerSettingsSnapshot.js";

function view(revision: number): ProviderSettingsView {
  return { revision, addableProviders: [], providerOrder: [], providers: [] };
}

describe("providerSettingsSnapshot", () => {
  it("先订阅再读取，迟到的旧 getView 不会覆盖新 revision", async () => {
    resetProviderSettingsSnapshotForTest();
    let resolveInitial: ((value: ProviderSettingsView) => void) | undefined;
    let emit: ((value: ProviderSettingsView) => void) | undefined;
    const dispose = vi.fn();
    const service = {
      getView: vi.fn(
        () =>
          new Promise<ProviderSettingsView>((resolve) => {
            resolveInitial = resolve;
          }),
      ),
      onDidChange: vi.fn((listener: (value: ProviderSettingsView) => void) => {
        emit = listener;
        return { dispose };
      }),
    } as unknown as IProviderSettingsService;

    const connection = connectProviderSettingsSnapshot(service);
    emit?.(view(2));
    resolveInitial?.(view(1));
    await connection.ready;

    expect(getProviderSettingsSnapshot()).toEqual({ status: "ready", view: view(2) });
    connection.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("首次读取失败进入 error，reload 后恢复 ready", async () => {
    resetProviderSettingsSnapshotForTest();
    const service = {
      getView: vi
        .fn<() => Promise<ProviderSettingsView>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(view(3)),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as IProviderSettingsService;

    const connection = connectProviderSettingsSnapshot(service);
    await expect(connection.ready).rejects.toThrow("offline");
    expect(getProviderSettingsSnapshot()).toMatchObject({ status: "error" });
    await connection.reload();
    expect(getProviderSettingsSnapshot()).toEqual({ status: "ready", view: view(3) });
  });
});
