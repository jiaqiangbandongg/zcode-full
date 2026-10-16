import { describe, expect, it, vi } from "vitest";
import type { IProviderSettingsService } from "@zcode/services";
import { refreshRootProviderState } from "@/root/useRootProviderStateRefresh.js";

describe("refreshRootProviderState", () => {
  it("刷新当前 Provider Runtime", async () => {
    const refresh = vi.fn(async () => ({ revision: 1, providers: [] }));

    await refreshRootProviderState({
      providerSettingsService: {
        refresh,
      } as unknown as IProviderSettingsService,
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith("root-provider-state-refresh");
  });
});
