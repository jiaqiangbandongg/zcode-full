import { describe, expect, it } from "vitest";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";

describe("sortModelProvidersForDisplay", () => {
  it("没有显式顺序时保留 Registry View 的输入顺序", () => {
    const providers = [
      { providerId: "account:bigmodel-individual-coding-plan" },
      { providerId: "account:zai-start-plan" },
      { providerId: "personal-provider" },
    ];

    expect(sortModelProvidersForDisplay(providers).map((provider) => provider.providerId)).toEqual([
      "account:bigmodel-individual-coding-plan",
      "account:zai-start-plan",
      "personal-provider",
    ]);
  });

  it("显式顺序覆盖输入顺序，未列出的 Provider 保持相对顺序", () => {
    const providers = [{ providerId: "a" }, { providerId: "b" }, { providerId: "c" }];

    expect(
      sortModelProvidersForDisplay(providers, { providerIds: ["c", "a"] }).map(
        (provider) => provider.providerId,
      ),
    ).toEqual(["c", "a", "b"]);
  });
});
