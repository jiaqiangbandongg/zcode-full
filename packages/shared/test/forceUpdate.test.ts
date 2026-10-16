import { describe, expect, it } from "vitest";
import { compareSemverVersions, resolveForceUpdateRequirement } from "../src/forceUpdate.js";

describe("forceUpdate", () => {
  it("未下发 forceUpdate 时不比较版本", () => {
    expect(
      resolveForceUpdateRequirement({
        currentVersion: "3.1.7",
        forceUpdate: null,
      }),
    ).toBeNull();
  });

  it("本地版本小于 minimalVersion 时要求强制升级", () => {
    expect(
      resolveForceUpdateRequirement({
        currentVersion: "3.9.9",
        forceUpdate: { minimalVersion: "4.0.0" },
      }),
    ).toEqual({
      currentVersion: "3.9.9",
      minimalVersion: "4.0.0",
    });
  });

  it("本地版本大于等于 minimalVersion 时不强制升级", () => {
    expect(
      resolveForceUpdateRequirement({
        currentVersion: "4.0.0",
        forceUpdate: { minimalVersion: "4.0.0" },
      }),
    ).toBeNull();
    expect(
      resolveForceUpdateRequirement({
        currentVersion: "4.0.1",
        forceUpdate: { minimalVersion: "4.0.0" },
      }),
    ).toBeNull();
  });

  it("按 semver 处理预发布版本", () => {
    expect(compareSemverVersions("4.0.0-beta.1", "4.0.0")).toBeLessThan(0);
    expect(compareSemverVersions("4.0.0-beta.2", "4.0.0-beta.1")).toBeGreaterThan(0);
  });

  it("minimalVersion 非法时不强制升级", () => {
    expect(
      resolveForceUpdateRequirement({
        currentVersion: "3.1.7",
        forceUpdate: { minimalVersion: "latest" },
      }),
    ).toBeNull();
  });

  it("minimalVersion 只有主版本号时自动补齐次版本号和修订号", () => {
    // "45" → 自动补齐为 "45.0.0"，本地 3.1.7 < 45.0.0 所以触发
    expect(
      resolveForceUpdateRequirement({
        currentVersion: "3.1.7",
        forceUpdate: { minimalVersion: "45" },
      }),
    ).toEqual({
      currentVersion: "3.1.7",
      minimalVersion: "45",
    });
  });

  it("minimalVersion 只有主次版本号时自动补齐修订号", () => {
    // "4.5" → 自动补齐为 "4.5.0"，本地 3.1.7 < 4.5.0 所以触发
    expect(
      resolveForceUpdateRequirement({
        currentVersion: "3.1.7",
        forceUpdate: { minimalVersion: "4.5" },
      }),
    ).toEqual({
      currentVersion: "3.1.7",
      minimalVersion: "4.5",
    });
  });

  it("当前版本大于补齐后的 minimalVersion 时不触发", () => {
    expect(
      resolveForceUpdateRequirement({
        currentVersion: "4.6.0",
        forceUpdate: { minimalVersion: "4.5" }, // 补齐为 4.5.0
      }),
    ).toBeNull();
  });
});
