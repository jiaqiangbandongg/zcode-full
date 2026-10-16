import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const homes: string[] = [];
const oldFields = {
  providerFamilyDomain: "bigmodel",
  modelProviderFamilyModes: { bigmodel: "oauth" },
  modelProviderFamilySelectedKeys: {
    bigmodel: "team-plan:builtin:bigmodel-coding-plan:product:project",
  },
};

async function setup(raw: unknown = oldFields) {
  const home = await mkdtemp(join(tmpdir(), "zcode-team-migration-"));
  homes.push(home);
  process.env.HOME = home;
  const dir = join(home, ".zcode", "v2");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "setting.json");
  await writeFile(file, JSON.stringify(raw));
  vi.resetModules();
  const { createSettingServiceWithMigrations } = await import("../src/setting/settingService.js");
  return {
    ...createSettingServiceWithMigrations(),
    read: async () => JSON.parse(await readFile(file, "utf8")),
  };
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("旧 Team 连接组织补齐的实际设置边界", () => {
  it("普通设置读取和保存不把待迁移连接写成新版空选择", async () => {
    const { service, read } = await setup();
    await service.get();
    await service.update({ locale: "en-US" });
    expect(await read()).toMatchObject({ ...oldFields, locale: "en-US" });
    expect(await read()).not.toHaveProperty("providerFamilyConnectionSelections");
  });

  it("迁移查询可以读取代理设置并保存普通偏好，完成后保存完整身份且旧字段仍在", async () => {
    const { service, prepareLegacyAccountConnections, read } = await setup();
    const resolve = vi.fn(async () => {
      await service.get();
      await service.update({ locale: "en-US" });
      return "organization";
    });
    expect(await prepareLegacyAccountConnections(resolve)).toEqual([]);
    expect(resolve).toHaveBeenCalledWith({
      family: "bigmodel",
      productId: "product",
      projectId: "project",
    });
    expect(await read()).toMatchObject({
      ...oldFields,
      locale: "en-US",
      providerFamilyConnectionSelections: {
        bigmodel: {
          kind: "team-coding-plan",
          productId: "product",
          projectId: "project",
          organizationId: "organization",
        },
      },
    });
    expect(await prepareLegacyAccountConnections(resolve)).toEqual([]);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it.each(["unknown", "failed"])("%s 保留待迁移记录，下一次现有刷新可重新尝试", async (outcome) => {
    const { prepareLegacyAccountConnections, read } = await setup();
    expect(
      await prepareLegacyAccountConnections(async () => {
        if (outcome === "failed") throw new Error("offline");
        return null;
      }),
    ).toEqual(["bigmodel"]);
    expect(await read()).not.toHaveProperty("providerFamilyConnectionSelections");
    expect(await prepareLegacyAccountConnections(async () => "organization")).toEqual([]);
  });

  it.each(["connection", "domain"])("等待期间用户修改 %s，迟到迁移不能覆盖", async (field) => {
    const { service, prepareLegacyAccountConnections, read } = await setup();
    await prepareLegacyAccountConnections(async () => {
      await service.update(
        field === "connection"
          ? { providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } } }
          : { providerFamilyDomain: "zai" },
      );
      return "old-organization";
    });
    const stored = await read();
    if (field === "connection")
      expect(stored.providerFamilyConnectionSelections.bigmodel).toEqual({
        kind: "individual-coding-plan",
      });
    else {
      expect(stored.providerFamilyDomain).toBe("zai");
      expect(stored).not.toHaveProperty("providerFamilyConnectionSelections");
    }
  });

  it.each([
    { ...oldFields, providerFamilyConnectionSelections: {} },
    { ...oldFields, modelProviderFamilyModes: { bigmodel: "apiKey" } },
    {
      ...oldFields,
      modelProviderFamilySelectedKeys: {
        bigmodel: "team-plan:builtin:bigmodel-coding-plan:product:org:project",
      },
    },
  ])("不需要组织补齐的记录不发查询", async (raw) => {
    const { prepareLegacyAccountConnections } = await setup(raw);
    const resolve = vi.fn(async () => "organization");
    expect(await prepareLegacyAccountConnections(resolve)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
