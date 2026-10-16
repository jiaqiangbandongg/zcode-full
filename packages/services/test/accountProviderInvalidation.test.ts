import { describe, expect, it, vi } from "vitest";
import {
  bindAccountProviderInvalidation,
  type SettingUpdatedEvent,
} from "../src/model-provider/accountProviderInvalidation.js";

function createSource<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    subscribe(listener: (event: T) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: T): void {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("Account Provider invalidation", () => {
  it("只把账号连接设置变化转成刷新", async () => {
    const settingUpdates = createSource<SettingUpdatedEvent>();
    const refresh = vi.fn(async () => undefined);
    const dispose = bindAccountProviderInvalidation({
      onDidUpdateSetting: settingUpdates.subscribe,
      refresh,
    });

    settingUpdates.emit({ keys: ["locale"] });
    settingUpdates.emit({
      keys: ["theme", "providerFamilyConnectionSelections"],
    });
    await Promise.resolve();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenNthCalledWith(1, "settings:providerFamilyConnectionSelections");

    dispose();
    settingUpdates.emit({ keys: ["providerFamilyDomain"] });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
