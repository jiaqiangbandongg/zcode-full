import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { onboardingRecordFileSchema } from "@zcode/shared";

/** 远程场景从已完成引导的隔离账号开始；导航专项仍走自己的真实引导链。 */
export async function seedRemoteOnboardingFixture(options: {
  enabled: boolean;
  specs: readonly string[];
  appConfigDir: string;
  userId: string;
}): Promise<void> {
  if (
    !options.enabled ||
    options.specs.some((spec) =>
      spec.endsWith("conversation-session-rpn-project-navigation.test.ts"),
    )
  )
    return;

  // 只填 setting.json 不足以完成新引导，产品按独立记录及当前 userId 判定。
  // 保留匿名条目供 live 账号登录认领，不伪造真实账号或绕开服务的认领规则。
  const record = onboardingRecordFileSchema.parse({
    version: 1,
    deviceMid: "zcode-remote-e2e-device",
    entries: [options.userId, null].map((userId) => ({
      userId,
      occupation: "developer",
      interfaceMode: "coding",
      memoryEnabled: false,
      proactiveSuggestionsEnabled: false,
      completedAt: new Date().toISOString(),
      uploadState: "pending",
    })),
  });
  await mkdir(options.appConfigDir, { recursive: true });
  await writeFile(
    join(options.appConfigDir, "onboarding-record.json"),
    JSON.stringify(record, null, 2),
  );
  const settingsPath = join(options.appConfigDir, "setting.json");
  const settings = await readFile(settingsPath, "utf8").then(
    (contents) => JSON.parse(contents),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return {};
    },
  );
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        ...settings,
        onboardingOccupation: "developer",
        memoryEnabled: false,
        proactiveSuggestionsEnabled: false,
      },
      null,
      2,
    ),
  );
}
