import { describe, expect, it, vi } from "vitest";
import type { ISettingService } from "../src/setting/setting.js";
import { createObservableSettingService } from "../src/setting/observableSettingService.js";

function createBaseSettingService(
  update: ISettingService["update"],
): ISettingService {
  return {
    get: vi.fn(),
    update,
    updateDataBaseDir: vi.fn(),
    ensureDefaultProject: vi.fn(),
  };
}

describe("Observable Setting Service", () => {
  it("底层更新成功后发布字段，失败时不发布", async () => {
    const update = vi.fn(async () => undefined);
    const service = createObservableSettingService(
      createBaseSettingService(update),
    );
    const events: string[][] = [];
    service.onDidUpdate((event) => events.push([...event.keys]));

    await service.update({
      providerFamilyDomain: "zai",
      modelProviderFamilyModes: { zai: "oauth" },
    });
    expect(events).toEqual([
      ["providerFamilyDomain", "modelProviderFamilyModes"],
    ]);

    update.mockRejectedValueOnce(new Error("write failed"));
    await expect(service.update({ providerFamilyDomain: "bigmodel" })).rejects.toThrow(
      "write failed",
    );
    expect(events).toHaveLength(1);
  });
});
