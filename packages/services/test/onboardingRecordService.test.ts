import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IOnboardingRecordService,
  OnboardingRecordServiceFactory,
} from "../src/onboarding/onboardingRecord.js";

const originalHome = process.env.HOME;
const originalDataBaseDir = process.env.ZCODE_DATA_BASE_DIR;
const tempHomes: string[] = [];

function recordFilePath(home: string): string {
  return join(home, ".zcode", "v2", "onboarding-record.json");
}

async function createServiceInHome(
  home: string,
  userId: string | null,
  hasExistingLocalTask = false,
): Promise<IOnboardingRecordService> {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/onboarding/onboardingRecordService.js");
  const factory = mod.createOnboardingRecordService as OnboardingRecordServiceFactory;
  return factory({
    loadUserId: () => Promise.resolve(userId),
    hasExistingLocalTask: () => Promise.resolve(hasExistingLocalTask),
  });
}

function makeEntry(
  overrides: Partial<Parameters<IOnboardingRecordService["appendRecord"]>[1]> = {},
) {
  return {
    occupation: "developer",
    interfaceMode: "coding",
    memoryEnabled: false,
    proactiveSuggestionsEnabled: true,
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataBaseDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
  else process.env.ZCODE_DATA_BASE_DIR = originalDataBaseDir;
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("onboardingRecordService", () => {
  it("本地无持久化文件时 shouldOnboard 为 true", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    expect(await service.shouldOnboard("device-a")).toBe(true);
  });

  it("无作答但已有真实 Task 时记为本机存量用户，后续不再展示", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1", true);

    expect(await service.shouldOnboard("device-a")).toBe(false);
    expect(await service.getRecords()).toMatchObject({
      version: 2,
      entries: [],
      decisions: [
        { userId: "u1", status: "existing_local_user", reason: "existing_local_task" },
      ],
    });
  });

  it("关闭首次引导持久化 dismissed，且不伪造作答 entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");

    await service.dismissOnboarding("device-a");
    expect(await service.shouldOnboard("device-a")).toBe(false);
    expect(await service.getRecords()).toMatchObject({
      entries: [],
      decisions: [{ userId: "u1", status: "dismissed", reason: "user_closed" }],
    });
  });

  it("v1 文件按空 decisions 读取，发生写入后自然升级 v2", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
      recordFilePath(home),
      JSON.stringify({ version: 1, deviceMid: "device-a", entries: [] }),
    );
    const service = await createServiceInHome(home, "u1");

    expect(await service.getRecords()).toMatchObject({ version: 2, decisions: [] });
    await service.dismissOnboarding("device-a");
    expect(JSON.parse(readFileSync(recordFilePath(home), "utf-8"))).toMatchObject({
      version: 2,
      decisions: [{ status: "dismissed" }],
    });
  });

  it("匿名 dismissal 登录后移交给当前用户，不重复展示", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const anonymous = await createServiceInHome(home, null);
    await anonymous.dismissOnboarding("device-a");
    const logged = await createServiceInHome(home, "u1");

    await logged.claimAnonymousRecord();
    expect(await logged.shouldOnboard("device-a")).toBe(false);
    expect(await logged.getRecords()).toMatchObject({
      decisions: [{ userId: "u1", status: "dismissed" }],
    });
  });

  it("append 首次创建文件并固化 deviceMid，同 userId 覆盖、不同 userId 各占一条", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    await service.appendRecord("device-a", makeEntry());
    // 同一用户再次完成引导：覆盖而不是追加
    await service.appendRecord("device-b", makeEntry({ occupation: "student" }));
    // 换用户：新增一条
    const serviceU2 = await createServiceInHome(home, "u2");
    await serviceU2.appendRecord("device-c", makeEntry({ occupation: "finance" }));

    const file = JSON.parse(readFileSync(recordFilePath(home), "utf-8"));
    expect(file.deviceMid).toBe("device-a");
    expect(file.entries).toHaveLength(2);
    expect(file.entries.find((e: { userId: string }) => e.userId === "u1")?.occupation).toBe(
      "student",
    );
    expect(file.entries.find((e: { userId: string }) => e.userId === "u2")?.occupation).toBe(
      "finance",
    );
  });

  it("append 由服务补全 userId 并默认 uploadState=pending", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    await service.appendRecord("device-a", makeEntry());

    const file = JSON.parse(readFileSync(recordFilePath(home), "utf-8"));
    expect(file.entries[0].userId).toBe("u1");
    expect(file.entries[0].uploadState).toBe("pending");
  });

  it("当前用户已有记录时不再触发；其他用户的记录不满足当前用户", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    await service.appendRecord("device-a", makeEntry());
    expect(await service.shouldOnboard("device-a")).toBe(false);

    const serviceU2 = await createServiceInHome(home, "u2");
    expect(await serviceU2.shouldOnboard("device-a")).toBe(true);
  });

  it("未登录（userId=null）按 null 记录匹配，登录用户记录不抵扣 null", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const logged = await createServiceInHome(home, "u1");
    await logged.appendRecord("device-a", makeEntry());

    const anonymous = await createServiceInHome(home, null);
    expect(await anonymous.shouldOnboard("device-a")).toBe(true);
    await anonymous.appendRecord("device-a", makeEntry());
    expect(await anonymous.shouldOnboard("device-a")).toBe(false);

    const loggedAgain = await createServiceInHome(home, "u1");
    expect(await loggedAgain.shouldOnboard("device-a")).toBe(false);
  });

  it("非法 entry（空职业）被 schema 拒绝且不落盘", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    await expect(service.appendRecord("device-a", makeEntry({ occupation: "" }))).rejects.toThrow();
    expect(existsSync(recordFilePath(home))).toBe(false);
  });

  it("损坏的记录文件触发重新引导，append 会重建合法文件", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(recordFilePath(home), "{not-json", { flag: "wx" });

    const service = await createServiceInHome(home, "u1");
    expect(await service.shouldOnboard("device-a")).toBe(true);
    await service.appendRecord("device-a", makeEntry());
    const file = JSON.parse(readFileSync(recordFilePath(home), "utf-8"));
    expect(file.entries).toHaveLength(1);
  });

  it("clearRecords 删除文件后再次触发引导", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    await service.appendRecord("device-a", makeEntry());
    await service.clearRecords();
    expect(existsSync(recordFilePath(home))).toBe(false);
    expect(await service.shouldOnboard("device-a")).toBe(true);
  });

  it("自定义 dataBaseDir 时记录跟随数据目录而非 home", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-onboarding-data-"));
    tempHomes.push(dataBaseDir);
    process.env.HOME = home;
    // paths.ts 在模块导入时捕获 ZCODE_DATA_BASE_DIR；host 进程正是经该环境变量下发 dataBaseDir。
    process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;
    vi.resetModules();
    const mod = await import("../src/onboarding/onboardingRecordService.js");
    const service = mod.createOnboardingRecordService({
      loadUserId: () => Promise.resolve("u1"),
      hasExistingLocalTask: () => Promise.resolve(false),
    });
    await service.appendRecord("device-a", makeEntry());

    const expected = join(dataBaseDir, ".zcode", "v2", "onboarding-record.json");
    expect(existsSync(expected)).toBe(true);
    expect(existsSync(recordFilePath(home))).toBe(false);
  });

  it("跳过页记 null 也能通过 schema 落盘", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, null);
    await service.appendRecord(
      "device-a",
      makeEntry({
        occupation: null,
        interfaceMode: null,
        memoryEnabled: null,
        proactiveSuggestionsEnabled: null,
      }),
    );
    const file = JSON.parse(readFileSync(recordFilePath(home), "utf-8"));
    expect(file.entries[0]).toMatchObject({
      userId: null,
      occupation: null,
      interfaceMode: null,
      memoryEnabled: null,
      proactiveSuggestionsEnabled: null,
    });
  });

  it("登录认领：null 条目移交给无条目的登录用户，已有条目/匿名态为空操作", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    // 匿名答一次
    const anonymous = await createServiceInHome(home, null);
    await anonymous.appendRecord("device-a", makeEntry({ occupation: "student" }));
    // 登录 A：移交（数组只有 null 一项时 null 变成 A）
    const serviceA = await createServiceInHome(home, "u1");
    await serviceA.claimAnonymousRecord();
    expect(await serviceA.getRecords()).toMatchObject({
      entries: [{ userId: "u1", occupation: "student" }],
    });
    // A 已有条目：幂等空操作
    await serviceA.claimAnonymousRecord();
    expect((await serviceA.getRecords())?.entries).toHaveLength(1);
    // 登出后匿名态再答一条：[A, null]；登录 B 认领 null → [A, B]
    await anonymous.appendRecord("device-a", makeEntry({ occupation: "finance" }));
    const serviceB = await createServiceInHome(home, "u2");
    await serviceB.claimAnonymousRecord();
    const entries = (await serviceB.getRecords())?.entries ?? [];
    expect(entries.map((e) => [e.userId, e.occupation])).toEqual([
      ["u1", "student"],
      ["u2", "finance"],
    ]);
  });

  it("syncSettingsFromRecord 回填当前用户最近作答；跳过 null 回填保守默认", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    await service.appendRecord(
      "device-a",
      makeEntry({ occupation: "finance", memoryEnabled: true }),
    );
    // 第二次完成（跳过语义的全 null 条目）覆盖第一次作答
    await service.appendRecord(
      "device-a",
      makeEntry({
        occupation: null,
        interfaceMode: null,
        memoryEnabled: null,
        proactiveSuggestionsEnabled: null,
      }),
    );

    expect(await service.syncSettingsFromRecord()).toEqual({
      onboardingOccupation: "other",
      proactiveSuggestionsEnabled: false,
      memoryEnabled: false,
    });

    const serviceU2 = await createServiceInHome(home, "u2");
    expect(await serviceU2.syncSettingsFromRecord()).toBeNull();
  });

  it("syncSettingsFromRecord 回填非 null 作答原值", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    await service.appendRecord(
      "device-a",
      makeEntry({ occupation: "finance", memoryEnabled: true, proactiveSuggestionsEnabled: true }),
    );
    expect(await service.syncSettingsFromRecord()).toEqual({
      onboardingOccupation: "finance",
      proactiveSuggestionsEnabled: true,
      memoryEnabled: true,
    });
  });

  it("updateRecordPreferences 更新当前用户条目；无条目时忽略", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    await service.appendRecord("device-a", makeEntry({ proactiveSuggestionsEnabled: true }));

    await service.updateRecordPreferences({
      proactiveSuggestionsEnabled: false,
      memoryEnabled: true,
    });
    const records = await service.getRecords();
    expect(records?.entries[0]).toMatchObject({
      userId: "u1",
      proactiveSuggestionsEnabled: false,
      memoryEnabled: true,
      // 未指定的字段保持原值
      occupation: "developer",
    });

    // 其他用户条目不受影响；无条目用户忽略
    const serviceU2 = await createServiceInHome(home, "u2");
    await serviceU2.updateRecordPreferences({ memoryEnabled: false });
    expect((await serviceU2.getRecords())?.entries).toHaveLength(1);
  });

  it("getRecords 返回整份文件供后续上传使用", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-onboarding-home-"));
    tempHomes.push(home);
    const service = await createServiceInHome(home, "u1");
    expect(await service.getRecords()).toBeNull();
    await service.appendRecord("device-a", makeEntry());
    const records = await service.getRecords();
    expect(records?.deviceMid).toBe("device-a");
    expect(records?.entries).toHaveLength(1);
  });
});
