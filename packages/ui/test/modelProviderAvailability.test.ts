import { describe, expect, it } from "vitest";
import {
  resolveProviderAvailabilityState,
} from "@/lib/modelProviderAvailability.js";

describe("modelProviderAvailability", () => {
  it("新 Host 只使用 Registry Selection View 判断启动可用性", () => {
    expect(
      resolveProviderAvailabilityState({
        modelSelectionView: {
          revision: 3,
          providers: [
            {
              providerId: "registry-provider",
              config: { kind: "api" },
              models: [{ modelId: "registry-model", config: {} }],
            },
          ],
        },
      }),
    ).toEqual({
      source: "registry",
      hydrated: true,
      providerCount: 1,
      hasUsableProvider: true,
    });
  });

  it("Registry 已确认空 View 时不会回退旧 Provider Snapshot", () => {
    expect(
      resolveProviderAvailabilityState({
        modelSelectionView: { revision: 4, providers: [] },
      }),
    ).toEqual({
      source: "registry",
      hydrated: true,
      providerCount: 0,
      hasUsableProvider: false,
    });
  });

  it("Registry 尚未水合时不会提前放行启动", () => {
    expect(
      resolveProviderAvailabilityState({
        modelSelectionView: null,
      }),
    ).toEqual({
      source: "registry",
      hydrated: false,
      providerCount: 0,
      hasUsableProvider: false,
    });
  });

});
