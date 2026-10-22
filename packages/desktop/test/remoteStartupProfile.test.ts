import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOnboardingRecordService } from "../../services/src/onboarding/onboardingRecordService.js";
import { getAppConfigDir, setDataBaseDir } from "../../services/src/paths.js";
import { seedRemoteOnboardingFixture } from "./e2e/helpers/remote-startup-profile.js";

const homes: string[] = [];
const fixtureUser = "zcode-e2e-user";
const remoteSpec = "conversation-session-ssh-remote-connection-p0.test.ts";
const fixtureDeviceMid = "e2e-device-mid";

// E2E 冷启动的 profile 里没有本地任务；只验证引导记录 fixture 本身是否生效。
function createService(userId: string | null) {
  return createOnboardingRecordService({
    loadUserId: async () => userId,
    hasExistingLocalTask: async () => false,
  });
}

async function prepare(enabled: boolean, spec = remoteSpec) {
  const home = await mkdtemp(join(tmpdir(), "zcode-remote-startup-"));
  homes.push(home);
  setDataBaseDir(home);
  await seedRemoteOnboardingFixture({
    enabled,
    specs: [spec],
    appConfigDir: getAppConfigDir(),
    userId: fixtureUser,
  });
}

afterEach(async () => {
  setDataBaseDir(null);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("远程 E2E 的已完成引导前置", () => {
  it("真实记录服务认可回放用户与匿名记录，live 登录可认领匿名记录", async () => {
    await prepare(true);
    for (const userId of [fixtureUser, null]) {
      const service = createService(userId);
      expect(await service.shouldOnboard(fixtureDeviceMid)).toBe(false);
      expect(await service.syncSettingsFromRecord()).toMatchObject({
        memoryEnabled: false,
        proactiveSuggestionsEnabled: false,
      });
    }
    const live = createService("live-e2e-user");
    await live.claimAnonymousRecord();
    expect(await live.shouldOnboard(fixtureDeviceMid)).toBe(false);
    expect((await live.getRecords())?.entries.map((entry) => entry.userId)).toEqual([
      fixtureUser,
      "live-e2e-user",
    ]);
  });

  it("不改变普通 E2E 的首次引导", async () => {
    await prepare(false);
    const service = createService(fixtureUser);
    expect(await service.shouldOnboard(fixtureDeviceMid)).toBe(true);
  });

  it("项目导航 case 保留真实完成引导及冷重启的验收路径", async () => {
    await prepare(true, "conversation-session-rpn-project-navigation.test.ts");
    const service = createService(fixtureUser);
    expect(await service.shouldOnboard(fixtureDeviceMid)).toBe(true);
  });
});
