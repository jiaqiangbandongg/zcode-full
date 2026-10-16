import { describe, expect, it, vi } from "vitest";

// 模拟未配置内网依赖源的构建环境（例如开源构建）：内网地址解析抛错。
vi.mock("../../../scripts/intranetDefaults.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntranetDepsBaseUrl: () => {
    throw new Error("Configure ZCODE_DEPS_BASE_URL or INTRANET_MACHINE_HOST");
  },
}));

const { OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR, resolveElectronBuilderBinariesMirror } =
  await import("../scripts/bundle.mjs");

describe("未配置内网依赖源时的 electron-builder binaries 镜像", () => {
  it("回退到官方 release 下载地址，打包不因内网地址缺失而失败", () => {
    expect(resolveElectronBuilderBinariesMirror({})).toBe(
      OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR,
    );
  });

  it("显式配置的镜像仍然优先", () => {
    expect(
      resolveElectronBuilderBinariesMirror({
        ELECTRON_BUILDER_BINARIES_MIRROR: "https://example.test/electron-builder-binaries/",
      }),
    ).toBe("https://example.test/electron-builder-binaries/");
  });
});
