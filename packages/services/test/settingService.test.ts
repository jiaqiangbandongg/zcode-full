import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "../src/setting/setting.js";

const originalHome = process.env.HOME;
const originalDesktopHome = process.env.ZCODE_DESKTOP_HOME_DIR;
const originalZCodeEnv = process.env.ZCODE_ENV;
const originalFsFaults = process.env.ZCODE_E2E_FS_FAULTS;
const originalFsFaultsAllow = process.env.ZCODE_E2E_FS_FAULTS_ALLOW;
const originalSettingWriteQueueTimeout = process.env.ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS;
const tempHomes: string[] = [];

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-setting-home-"));
  tempHomes.push(home);
  return home;
}

async function createSettingServiceInHome(home: string): Promise<ISettingService> {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/setting/settingService.js");
  return mod.createSettingService();
}

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.restoreAllMocks();
  restoreEnvValue("HOME", originalHome);
  restoreEnvValue("ZCODE_DESKTOP_HOME_DIR", originalDesktopHome);
  restoreEnvValue("ZCODE_ENV", originalZCodeEnv);
  restoreEnvValue("ZCODE_E2E_FS_FAULTS", originalFsFaults);
  restoreEnvValue("ZCODE_E2E_FS_FAULTS_ALLOW", originalFsFaultsAllow);
  restoreEnvValue("ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS", originalSettingWriteQueueTimeout);

  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("settingService", () => {
  it("显式桌面 home 覆盖只写隔离实例设置，不污染普通 home", async () => {
    const ordinaryHome = makeTempHome();
    const desktopHome = makeTempHome();
    process.env.ZCODE_DESKTOP_HOME_DIR = desktopHome;
    process.env.ZCODE_ENV = "production";
    const service = await createSettingServiceInHome(ordinaryHome);
    await service.update({ providerFamilyDomain: "bigmodel" });
    expect(existsSync(join(desktopHome, ".zcode", "v2", "setting.json"))).toBe(true);
    expect(existsSync(join(ordinaryHome, ".zcode", "v2", "setting.json"))).toBe(false);
    expect((await service.get()).providerFamilyDomain).toBe("bigmodel");
  });
  it("账号查询的迟到保存不能覆盖用户手动切换的连接", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);
    await service.update({
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } },
    });
    const original = await service.get();
    await service.update({
      providerFamilyConnectionSelections: {
        bigmodel: { kind: "team-coding-plan", productId: "p", organizationId: "o", projectId: "j" },
      },
    });
    await expect(
      service.update(
        { providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } } },
        {
          providerFamilyDomain: original.providerFamilyDomain,
          providerFamilyConnectionSelections: original.providerFamilyConnectionSelections,
        },
      ),
    ).rejects.toThrow("Account connection settings changed");
    expect((await service.get()).providerFamilyConnectionSelections?.bigmodel?.kind).toBe(
      "team-coding-plan",
    );
  });
  it("迁移旧账号连接并保留回滚字段，新版选择不再被旧字段覆盖", async () => {
    const home = makeTempHome();
    const dir = join(home, ".zcode", "v2");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "setting.json");
    const legacy = {
      modelProviderFamilyModes: { bigmodel: "oauth", zai: "oauth" },
      modelProviderFamilySelectedKeys: {
        bigmodel: "team-plan:builtin:bigmodel-coding-plan:pro:org%3Aa:project-a",
        zai: "coding-plan:builtin:zai-start-plan",
      },
      closeToTrayOnWindowsMigrationInitialized: true,
      messageStreamShowReasoningMigrationInitialized: true,
    };
    writeFileSync(file, JSON.stringify(legacy));
    const service = await createSettingServiceInHome(home);
    const expected = {
      bigmodel: {
        kind: "team-coding-plan",
        productId: "pro",
        organizationId: "org:a",
        projectId: "project-a",
      },
      zai: { kind: "start-plan" },
    };
    expect((await service.get()).providerFamilyConnectionSelections).toEqual(expected);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      ...legacy,
      providerFamilyConnectionSelections: expected,
    });
    await service.update({ providerFamilyConnectionSelections: {} });
    expect((await service.get()).providerFamilyConnectionSelections).toEqual({});
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      modelProviderFamilySelectedKeys: legacy.modelProviderFamilySelectedKeys,
    });
  });

  it("旧个人连接可迁移，API 模式和缺组织的 Team 不猜成个人套餐", async () => {
    const home = makeTempHome();
    const dir = join(home, ".zcode", "v2");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "setting.json");
    writeFileSync(
      file,
      JSON.stringify({
        modelProviderFamilySelectedKeys: {
          bigmodel: "coding-plan:builtin:bigmodel-coding-plan",
          zai: "team-plan:builtin:zai-coding-plan:pro:project",
        },
      }),
    );
    const service = await createSettingServiceInHome(home);
    expect((await service.get()).providerFamilyConnectionSelections).toEqual({
      bigmodel: { kind: "individual-coding-plan" },
    });
    writeFileSync(
      file,
      JSON.stringify({
        modelProviderFamilyModes: { bigmodel: "apiKey" },
        modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
      }),
    );
    expect((await service.get()).providerFamilyConnectionSelections).toEqual({});
  });

  it("缺少 setting.json 时返回默认值", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await expect(service.get()).resolves.toMatchObject({
      recentProjects: [],
      locale: "zh-CN",
      localePreference: "system",
      taskAutoArchiveEnabled: false,
      taskAutoArchiveOlderThanDays: 7,
      messageStreamShowReasoning: true,
      messageStreamShowReasoningMigrationInitialized: true,
      messageStreamShowTodos: false,
      nativeSearchEnhancementsEnabled: true,
      askUserQuestionAutoResolutionEnabled: true,
      memoryEnabled: false,
      lastWorkspaceSession: [],
      lastActiveTabIndex: 0,
    });
  });

  it("旧配置默认开启提问自动继续，并持久化显式关闭", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "setting.json"), JSON.stringify({ locale: "zh-CN" }), "utf-8");

    const service = await createSettingServiceInHome(home);
    await expect(service.get()).resolves.toMatchObject({
      askUserQuestionAutoResolutionEnabled: true,
    });
    await service.update({ askUserQuestionAutoResolutionEnabled: false });
    const reloadedService = await createSettingServiceInHome(home);
    await expect(reloadedService.get()).resolves.toMatchObject({
      askUserQuestionAutoResolutionEnabled: false,
    });
  });

  it("首次读取旧关闭到托盘配置时统一开启并持久化，之后保留用户关闭选择", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    const settingsFile = join(settingsDir, "setting.json");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({
        locale: "zh-CN",
        closeToTrayOnWindows: false,
      }),
      "utf-8",
    );

    const service = await createSettingServiceInHome(home);
    await expect(service.get()).resolves.toMatchObject({
      closeToTrayOnWindows: true,
      closeToTrayOnWindowsMigrationInitialized: true,
    });
    expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toMatchObject({
      closeToTrayOnWindows: true,
      closeToTrayOnWindowsMigrationInitialized: true,
    });

    await service.update({ closeToTrayOnWindows: false });
    const reloadedService = await createSettingServiceInHome(home);
    await expect(reloadedService.get()).resolves.toMatchObject({
      closeToTrayOnWindows: false,
      closeToTrayOnWindowsMigrationInitialized: true,
    });
  });

  it("首次读取旧 reasoning 配置时统一开启并持久化，之后保留用户关闭选择", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    const settingsFile = join(settingsDir, "setting.json");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({
        locale: "zh-CN",
        messageStreamShowReasoning: false,
        closeToTrayOnWindowsMigrationInitialized: true,
      }),
      "utf-8",
    );

    const service = await createSettingServiceInHome(home);
    await expect(service.get()).resolves.toMatchObject({
      messageStreamShowReasoning: true,
      messageStreamShowReasoningMigrationInitialized: true,
    });
    expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toMatchObject({
      messageStreamShowReasoning: true,
      messageStreamShowReasoningMigrationInitialized: true,
    });

    await service.update({ messageStreamShowReasoning: false });
    const reloadedService = await createSettingServiceInHome(home);
    await expect(reloadedService.get()).resolves.toMatchObject({
      messageStreamShowReasoning: false,
      messageStreamShowReasoningMigrationInitialized: true,
    });
    await expect(reloadedService.get()).resolves.toMatchObject({
      messageStreamShowReasoning: false,
      messageStreamShowReasoningMigrationInitialized: true,
    });
  });

  it("一次性设置迁移写盘会进入设置更新队列，避免覆盖并发设置更新", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    const settingsFile = join(settingsDir, "setting.json");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({
        locale: "zh-CN",
        messageStreamShowReasoning: false,
      }),
      "utf-8",
    );

    let releaseFirstSettingsWrite: (() => void) | undefined;
    let firstSettingsWriteStarted: (() => void) | undefined;
    const firstSettingsWriteStartedPromise = new Promise<void>((resolve) => {
      firstSettingsWriteStarted = resolve;
    });
    const firstSettingsWriteReleasePromise = new Promise<void>((resolve) => {
      releaseFirstSettingsWrite = resolve;
    });
    let settingsWriteCount = 0;

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
          const [file] = args;
          const filePath = String(file);
          if (filePath.startsWith(`${settingsFile}.`) && filePath.endsWith(".tmp")) {
            settingsWriteCount += 1;
            if (settingsWriteCount === 1) {
              firstSettingsWriteStarted?.();
              await firstSettingsWriteReleasePromise;
            }
          }
          return actual.writeFile(...args);
        }),
      };
    });

    const service = await createSettingServiceInHome(home);
    const getPromise = service.get();
    await firstSettingsWriteStartedPromise;

    let updateSettled = false;
    const updatePromise = service.update({ recentProjects: ["/tmp/new-project"] }).then(() => {
      updateSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateSettled).toBe(false);

    releaseFirstSettingsWrite?.();
    await Promise.all([getPromise, updatePromise]);

    expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toMatchObject({
      messageStreamShowReasoning: true,
      messageStreamShowReasoningMigrationInitialized: true,
      recentProjects: ["/tmp/new-project"],
    });
  });

  it("设置进入原子提交后会等待 rename 收口再保存后续语言偏好", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    const settingsFile = join(settingsDir, "setting.json");
    let firstSettingsRenameStarted: (() => void) | undefined;
    let releaseFirstSettingsWrite: (() => void) | undefined;
    let firstSettingsRenameFinished: (() => void) | undefined;
    const firstSettingsRenameStartedPromise = new Promise<void>((resolve) => {
      firstSettingsRenameStarted = resolve;
    });
    const firstSettingsWriteReleasePromise = new Promise<void>((resolve) => {
      releaseFirstSettingsWrite = resolve;
    });
    const firstSettingsRenameFinishedPromise = new Promise<void>((resolve) => {
      firstSettingsRenameFinished = resolve;
    });
    process.env.ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS = "100";

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let settingsRenameCount = 0;
      return {
        ...actual,
        rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
          const [oldPath, newPath] = args;
          if (
            String(oldPath).startsWith(`${settingsFile}.`) &&
            String(oldPath).endsWith(".tmp") &&
            String(newPath) === settingsFile
          ) {
            settingsRenameCount += 1;
            if (settingsRenameCount === 1) {
              firstSettingsRenameStarted?.();
              await firstSettingsWriteReleasePromise;
              await actual.rename(...args);
              firstSettingsRenameFinished?.();
              return;
            }
          }
          return actual.rename(...args);
        }),
      };
    });

    const service = await createSettingServiceInHome(home);
    const blockedUpdate = service.update({
      locale: "en-US",
      localePreference: "en-US",
    });
    let blockedUpdateSettled = false;
    void blockedUpdate.then(
      () => {
        blockedUpdateSettled = true;
      },
      () => {
        blockedUpdateSettled = true;
      },
    );
    await firstSettingsRenameStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(blockedUpdateSettled).toBe(false);

    // Bugfix: 100ms 超时只为证明 rename 提交阶段会压制超时；后续写继承同一超时的话，
    // 高负载下会在等待临界区收口时先超时导致偶发失败，这里放宽回默认量级。
    process.env.ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS = "30000";
    const latestUpdate = service.update({
      locale: "zh-CN",
      localePreference: "system",
    });
    let latestUpdateSettled = false;
    void latestUpdate.then(
      () => {
        latestUpdateSettled = true;
      },
      () => {
        latestUpdateSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(latestUpdateSettled).toBe(false);

    releaseFirstSettingsWrite?.();
    await Promise.all([blockedUpdate, firstSettingsRenameFinishedPromise]);
    await expect(latestUpdate).resolves.toBeUndefined();

    expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toMatchObject({
      locale: "zh-CN",
      localePreference: "system",
    });
    await vi.waitFor(() => {
      expect(
        readdirSync(settingsDir).filter(
          (file) => file.startsWith("setting.json.") && file.endsWith(".tmp"),
        ),
      ).toHaveLength(0);
    });
    expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toMatchObject({
      locale: "zh-CN",
      localePreference: "system",
    });
  });

  it("设置提交前写入超时会释放队列且晚到旧写不能覆盖语言偏好", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    const settingsFile = join(settingsDir, "setting.json");
    let firstSettingsWriteStarted: (() => void) | undefined;
    let releaseFirstSettingsWrite: (() => void) | undefined;
    const firstSettingsWriteStartedPromise = new Promise<void>((resolve) => {
      firstSettingsWriteStarted = resolve;
    });
    const firstSettingsWriteReleasePromise = new Promise<void>((resolve) => {
      releaseFirstSettingsWrite = resolve;
    });
    process.env.ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS = "50";

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let settingsWriteCount = 0;
      return {
        ...actual,
        writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
          const [file] = args;
          const filePath = String(file);
          if (filePath.startsWith(`${settingsFile}.`) && filePath.endsWith(".tmp")) {
            settingsWriteCount += 1;
            if (settingsWriteCount === 1) {
              firstSettingsWriteStarted?.();
              await firstSettingsWriteReleasePromise;
            }
          }
          return actual.writeFile(...args);
        }),
      };
    });

    const service = await createSettingServiceInHome(home);
    // 修复原因：真实 50ms 计时可能在准备 I/O 时到期，旧写因此根本不会进入
    // writeFile mock，等待 started 的 Promise 永远不收口。到写入屏障后再推进时钟。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const staleUpdate = service.update({
        locale: "en-US",
        localePreference: "en-US",
      });
      const staleUpdateResult = staleUpdate.then(
        () => undefined,
        (error: unknown) => error,
      );
      await firstSettingsWriteStartedPromise;
      await vi.advanceTimersByTimeAsync(50);
      await expect(staleUpdateResult).resolves.toEqual(
        expect.objectContaining({
          message: "settingService update timed out after 50ms",
        }),
      );
    } finally {
      vi.useRealTimers();
    }

    // Bugfix: 后续写继承 50ms 超时的话，全量跑测试的高负载会让它在拿到文件锁前先超时，
    // 造成偶发失败；本用例只需第一笔写超时，第二笔写放宽到默认量级避免计时抖动。
    process.env.ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS = "30000";
    const latestUpdate = service.update({
      locale: "zh-CN",
      localePreference: "system",
    });

    releaseFirstSettingsWrite?.();
    await expect(latestUpdate).resolves.toBeUndefined();

    expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toMatchObject({
      locale: "zh-CN",
      localePreference: "system",
    });
    await vi.waitFor(() => {
      expect(
        readdirSync(settingsDir).filter(
          (file) => file.startsWith("setting.json.") && file.endsWith(".tmp"),
        ),
      ).toHaveLength(0);
    });
  });

  it("读取会等待已入队的设置更新，Session 启动偏好不会拿到旧值", async () => {
    const home = makeTempHome();
    const settingsFile = join(home, ".zcode", "v2", "setting.json");
    let releaseSettingsWrite: (() => void) | undefined;
    let settingsWriteStarted: (() => void) | undefined;
    const settingsWriteStartedPromise = new Promise<void>((resolve) => {
      settingsWriteStarted = resolve;
    });
    const settingsWriteReleasePromise = new Promise<void>((resolve) => {
      releaseSettingsWrite = resolve;
    });

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
          const filePath = String(args[0]);
          if (filePath.startsWith(`${settingsFile}.`) && filePath.endsWith(".tmp")) {
            settingsWriteStarted?.();
            await settingsWriteReleasePromise;
          }
          return actual.writeFile(...args);
        }),
      };
    });

    const service = await createSettingServiceInHome(home);
    const updatePromise = service.update({
      nativeSearchEnhancementsEnabled: false,
    });
    await settingsWriteStartedPromise;

    let readSettled = false;
    const readPromise = service.get().then((settings) => {
      readSettled = true;
      return settings;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readSettled).toBe(false);

    releaseSettingsWrite?.();
    await updatePromise;
    await expect(readPromise).resolves.toMatchObject({
      nativeSearchEnhancementsEnabled: false,
    });
  });

  it("Memory 开关会持久化并被后续读取", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({ memoryEnabled: true });

    await expect(service.get()).resolves.toMatchObject({ memoryEnabled: true });
  });

  it("setting.json 不是合法 JSON 时会隔离坏文件并在后续写回合法配置", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    const settingsFile = join(settingsDir, "setting.json");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsFile, ":wq\n", "utf-8");

    const service = await createSettingServiceInHome(home);

    await expect(service.get()).resolves.toMatchObject({
      recentProjects: [],
      locale: "zh-CN",
    });

    expect(existsSync(settingsFile)).toBe(false);
    const backupFiles = readdirSync(settingsDir).filter((file) =>
      file.startsWith("setting.json.corrupt-"),
    );
    expect(backupFiles).toHaveLength(1);
    expect(readFileSync(join(settingsDir, backupFiles[0] as string), "utf-8")).toBe(":wq\n");

    await service.update({ locale: "en-US" });

    expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toMatchObject({
      locale: "en-US",
      localePreference: "en-US",
    });
  });

  it("读取 setting.json 遇到短暂 JSON parse fail 时会重试并保留会话配置", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    const settingsFile = join(settingsDir, "setting.json");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsFile, '{"lastWorkspaceSession":[', "utf-8");

    const service = await createSettingServiceInHome(home);
    const pendingSettings = service.get();

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(
      settingsFile,
      JSON.stringify({
        locale: "en-US",
        recentProjects: ["/tmp/workspace-a"],
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: "/tmp/workspace-a",
          },
        ],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );

    await expect(pendingSettings).resolves.toMatchObject({
      locale: "en-US",
      recentProjects: ["/tmp/workspace-a"],
      lastWorkspaceSession: [
        {
          kind: "local",
          workspacePath: "/tmp/workspace-a",
        },
      ],
    });
    expect(
      readdirSync(settingsDir).filter((file) => file.startsWith("setting.json.corrupt-")),
    ).toHaveLength(0);
  });

  it("串行化并发补丁写入，避免 lastWorkspaceSession 被覆盖丢失", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await Promise.all([
      service.update({ recentProjects: ["/tmp/workspace-a"] }),
      service.update({
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: "/tmp/workspace-a",
          },
        ],
        lastActiveTabIndex: 0,
      }),
    ]);

    await expect(service.get()).resolves.toMatchObject({
      recentProjects: ["/tmp/workspace-a"],
      lastWorkspaceSession: [
        {
          kind: "local",
          workspacePath: "/tmp/workspace-a",
        },
      ],
      lastActiveTabIndex: 0,
    });
  });

  it("支持清空非生产 ZCode endpoint override", async () => {
    const home = makeTempHome();
    const settingsFile = join(home, ".zcode", "v2", "setting.json");
    const service = await createSettingServiceInHome(home);

    await service.update({ zcodeEndpointOrigin: "https://zcode.z.ai/path" });
    await expect(service.get()).resolves.toMatchObject({
      zcodeEndpointOrigin: "https://zcode.z.ai",
    });

    await service.update({ zcodeEndpointOrigin: "" });

    await expect(service.get()).resolves.not.toHaveProperty("zcodeEndpointOrigin");
    expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).not.toHaveProperty(
      "zcodeEndpointOrigin",
    );
  });

  it("忽略损坏的 ZCode endpoint override，保留其它 settings", async () => {
    const home = makeTempHome();
    const settingsDir = join(home, ".zcode", "v2");
    const settingsFile = join(settingsDir, "setting.json");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({
        locale: "en-US",
        recentProjects: ["/tmp/demo"],
        zcodeEndpointOrigin: ["ftp://invalid.example"],
      }),
      "utf-8",
    );

    const service = await createSettingServiceInHome(home);

    await expect(service.get()).resolves.toMatchObject({
      locale: "en-US",
      recentProjects: ["/tmp/demo"],
    });
    await expect(service.get()).resolves.not.toHaveProperty("zcodeEndpointOrigin");
  });

  it("会持久化 task 自动归档配置", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      taskAutoArchiveEnabled: true,
      taskAutoArchiveOlderThanDays: 14,
    });

    await expect(service.get()).resolves.toMatchObject({
      taskAutoArchiveEnabled: true,
      taskAutoArchiveOlderThanDays: 14,
    });
  });

  it("保存 setting.json 时可以注入磁盘/权限类写入错误", async () => {
    const home = makeTempHome();
    const settingsFile = join(home, ".zcode", "v2", "setting.json");
    process.env.ZCODE_ENV = "test";
    process.env.ZCODE_E2E_FS_FAULTS = JSON.stringify([
      {
        code: "EACCES",
        id: "D03-setting-write-eacces",
        operations: ["writeFile"],
        pathEndsWith: "/setting.json",
      },
    ]);
    const service = await createSettingServiceInHome(home);

    await expect(service.update({ locale: "en-US" })).rejects.toMatchObject({
      code: "EACCES",
      path: settingsFile,
      syscall: "writeFile",
      zcodeFsFaultId: "D03-setting-write-eacces",
    });

    expect(existsSync(settingsFile)).toBe(false);
  });

  it("会持久化消息流展示配置", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      messageStreamShowReasoning: false,
      messageStreamShowTodos: true,
    });

    await expect(service.get()).resolves.toMatchObject({
      messageStreamShowReasoning: false,
      messageStreamShowReasoningMigrationInitialized: true,
      messageStreamShowTodos: true,
    });
  });

  it("会持久化 ZCode 交互行为配置", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      zcodeInteractionBehavior: "guide",
    });

    await expect(service.get()).resolves.toMatchObject({
      zcodeInteractionBehavior: "guide",
    });
  });

  it("会持久化终端字体覆盖，并支持清空后回到自动继承", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      terminalFontFamily: " MesloLGS NF ",
    });

    await expect(service.get()).resolves.toMatchObject({
      terminalFontFamily: "MesloLGS NF",
    });

    await service.update({
      terminalFontFamily: "",
    });

    const reloadedService = await createSettingServiceInHome(home);
    const settings = await reloadedService.get();
    expect(settings.terminalFontFamily).toBeUndefined();
    expect(settings.terminalInheritSystemProfile).toBe(true);
  });

  it("会持久化 Windows 集成终端 shell 选择，并支持切回自动选择", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      integratedTerminalShell: {
        mode: "shell",
        dialect: "git-bash",
        id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
        label: "Git Bash",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
      },
    });

    await expect(service.get()).resolves.toMatchObject({
      integratedTerminalShell: {
        mode: "shell",
        dialect: "git-bash",
        id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
        label: "Git Bash",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
      },
    });

    await service.update({
      integratedTerminalShell: { mode: "auto" },
    });

    const reloadedService = await createSettingServiceInHome(home);
    const settings = await reloadedService.get();
    expect(settings.integratedTerminalShell).toBeUndefined();
  });

  it("会持久化 HTTP 代理，并支持清空后删除旧字段", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      httpProxy: " http://127.0.0.1:9091 ",
    });

    await expect(service.get()).resolves.toMatchObject({
      httpProxy: "http://127.0.0.1:9091",
    });

    await service.update({
      // Bugfix: UI 清空代理时传空串，服务层必须把它归一成未配置，
      // 否则旧 httpProxy 会继续留在 setting.json，重启 Agent 又会注入代理环境。
      httpProxy: "",
    });

    const reloadedService = await createSettingServiceInHome(home);
    const settings = await reloadedService.get();
    expect(settings.httpProxy).toBeUndefined();
  });

  it("会持久化 HTTP 代理绕过规则，并支持清空后删除旧字段", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      httpProxyNoProxy: " localhost,127.0.0.1,.example.com ",
    });

    await expect(service.get()).resolves.toMatchObject({
      httpProxyNoProxy: "localhost,127.0.0.1,.example.com",
    });

    await service.update({
      // Bugfix: No Proxy 清空时要删除旧值，避免重启后 renderer/agent 继续绕过代理。
      httpProxyNoProxy: "",
    });

    const reloadedService = await createSettingServiceInHome(home);
    const settings = await reloadedService.get();
    expect(settings.httpProxyNoProxy).toBeUndefined();
  });

  // DWG-19（docs/dynamic-workflow/launch.md「The user's choice」）：选回服务端提供的模式时，
  // UI 发空串删除选择，未改动的安装才能继续跟随服务端翻转。
  it("会持久化动态工作流模式选择，空串删除旧字段", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({ dynamicWorkflowMode: "onDemand" });
    await expect(service.get()).resolves.toMatchObject({ dynamicWorkflowMode: "onDemand" });

    await service.update({
      dynamicWorkflowMode: "" as unknown as AppSettings["dynamicWorkflowMode"],
    });
    const reloadedService = await createSettingServiceInHome(home);
    expect((await reloadedService.get()).dynamicWorkflowMode).toBeUndefined();
  });

  it("会持久化 HTTP 代理自定义证书路径，并支持清空后删除旧字段", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      httpProxyCaCertPath: " /Users/test/certs/root-ca.pem ",
    });

    await expect(service.get()).resolves.toMatchObject({
      httpProxyCaCertPath: "/Users/test/certs/root-ca.pem",
    });

    await service.update({
      // Bugfix: UI 清空自定义证书时传空串，服务层必须把它归一成未配置，
      // 否则下次启动 agent 仍会把旧路径注入 NODE_EXTRA_CA_CERTS。
      httpProxyCaCertPath: "",
    });

    const reloadedService = await createSettingServiceInHome(home);
    const settings = await reloadedService.get();
    expect(settings.httpProxyCaCertPath).toBeUndefined();
  });

  it("会持久化桌面 Chromium 硬件加速开关", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await expect(service.get()).resolves.toMatchObject({
      desktopChromiumHardwareAccelerationEnabled: true,
    });

    await service.update({
      desktopChromiumHardwareAccelerationEnabled: false,
    });

    const disabledService = await createSettingServiceInHome(home);
    await expect(disabledService.get()).resolves.toMatchObject({
      desktopChromiumHardwareAccelerationEnabled: false,
    });

    await disabledService.update({
      desktopChromiumHardwareAccelerationEnabled: true,
    });

    const enabledService = await createSettingServiceInHome(home);
    await expect(enabledService.get()).resolves.toMatchObject({
      desktopChromiumHardwareAccelerationEnabled: true,
    });
  });

  it("会持久化组合会话快照", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);

    await service.update({
      lastWorkspaceSession: [
        {
          kind: "local",
          workspacePath: "/tmp/local-demo",
        },
        {
          kind: "remote",
          workspacePath: "/workspace/demo",
          workspaceIdentity: "remote:ssh:demo.internal:22:root:/workspace/demo",
          target: {
            kind: "ssh",
            host: "demo.internal",
            username: "root",
            passwordCredentialKey:
              "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
          },
          lastOpenedAt: 123,
          lastConnectionStatus: "failed",
          lastConnectionError: "connection refused",
        },
      ],
    });

    await expect(service.get()).resolves.toMatchObject({
      lastWorkspaceSession: [
        {
          kind: "local",
          workspacePath: "/tmp/local-demo",
        },
        {
          kind: "remote",
          workspacePath: "/workspace/demo",
          workspaceIdentity: "remote:ssh:demo.internal:22:root:/workspace/demo",
          lastConnectionStatus: "failed",
        },
      ],
    });
  });

  it("读取旧版 settings 时会迁移 lastOpenTabs 和 remoteWorkspaceHistory", async () => {
    const home = makeTempHome();
    const settingsFile = join(home, ".zcode", "v2", "setting.json");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({
        recentProjects: ["/tmp/existing"],
        locale: "zh-CN",
        lastOpenTabs: ["/tmp/local-demo"],
        lastWorkspaceSession: [{ kind: "remote", historyId: "legacy-remote" }],
        remoteWorkspaceHistory: [
          {
            id: "legacy-remote",
            workspacePath: "/workspace/demo",
            target: {
              kind: "docker",
              container: "demo",
            },
            lastOpenedAt: 456,
            lastConnectionStatus: "failed",
          },
        ],
      }),
      "utf-8",
    );

    const reloadedService = await createSettingServiceInHome(home);
    const settings = await reloadedService.get();
    expect(settings.lastWorkspaceSession).toHaveLength(2);
    expect(settings.lastWorkspaceSession?.[0]).toMatchObject({
      kind: "remote",
      workspacePath: "/workspace/demo",
      target: {
        kind: "docker",
        container: "demo",
      },
      lastOpenedAt: 456,
      lastConnectionStatus: "failed",
    });
    expect(settings.lastWorkspaceSession?.[1]).toEqual({
      kind: "local",
      workspacePath: "/tmp/local-demo",
      workspacePurpose: "project",
    });
  });

  it("在用户目录下兜底创建默认项目，并准确返回是否首次创建", async () => {
    const home = makeTempHome();
    const service = await createSettingServiceInHome(home);
    const defaultProjectPath = join(home, "ZCodeProject");

    await expect(service.ensureDefaultProject(home)).resolves.toEqual({
      path: defaultProjectPath,
      created: true,
    });

    await expect(service.ensureDefaultProject(home)).resolves.toEqual({
      path: defaultProjectPath,
      created: false,
    });
  });
});
