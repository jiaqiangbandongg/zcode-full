import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServiceChannels } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

async function createProviderFixture(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  tempHomes.push(home);
  process.env.HOME = home;
  const filePath = join(home, "zcode-builtin.json");
  // 修复原因：只传 {} 会让后台 Provider 初始化读取 undefined 路径并写出错误日志。
  // 使用当前 Release 合同的空配置，让装配测试独立于真实用户配置和发布文件。
  await writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    }),
    "utf8",
  );
  return filePath;
}

describe("conversation share service composition", () => {
  beforeEach(() => {
    // 保留真实日志输出，同时让后台初始化错误也能使测试失败。
    vi.spyOn(console, "error");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ code: 0, data: { configs: {} } }),
    );
  });

  afterEach(async () => {
    try {
      for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true });
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it("registers a real API-backed service for a local desktop host", async () => {
    const zcodeBuiltinProviderConfigFilePath = await createProviderFixture(
      "zcode-conversation-share-",
    );
    const [nodeModule, servicesModule] = await Promise.all([
      import("@zcode/services/node"),
      import("@zcode/services"),
    ]);

    const services = nodeModule.createLocalServices({ zcodeBuiltinProviderConfigFilePath });
    try {
      await expect(
        services.get(servicesModule.IModelSelectionService).getView(),
      ).resolves.toMatchObject({
        providers: [],
      });
      const service = services.get(servicesModule.IConversationShareService);
      expect(typeof service.getCapabilities).toBe("function");
      expect(ServiceChannels.ConversationShare).toBe("conversation-share");
    } finally {
      // 修复原因：同步 dispose 后删 HOME，会让尚未收口的初始化/释放任务晚到写日志，
      // 与 Vitest worker 关闭日志 RPC 竞争；先等待服务释放，再由 afterEach 清理目录。
      await nodeModule.disposeServiceResourcesAndWait(services);
    }
  });

  it("keeps desktop-attached remote hosts behind the publishing boundary", async () => {
    const zcodeBuiltinProviderConfigFilePath = await createProviderFixture(
      "zcode-conversation-share-remote-",
    );
    const [nodeModule, servicesModule] = await Promise.all([
      import("@zcode/services/node"),
      import("@zcode/services"),
    ]);

    const services = nodeModule.createLocalServices({
      zcodeBuiltinProviderConfigFilePath,
      serviceAuthorityMode: "desktop-attached-remote",
    });
    try {
      await expect(
        services.get(servicesModule.IModelSelectionService).getView(),
      ).resolves.toMatchObject({
        providers: [],
      });
      await expect(
        services.get(servicesModule.IConversationShareService).getCapabilities(),
      ).rejects.toMatchObject({ kind: "feature_disabled" });
    } finally {
      await nodeModule.disposeServiceResourcesAndWait(services);
    }
  });
});
