import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  runSSHCommand,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import {
  prepareVersionPolicyArchive,
  uploadSSHFixtureFile,
} from "#e2e/helpers/ssh-version-policy-fixture";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  holdWizardSourceSnapshot,
  readSnapshotFaultUpdateCalls,
  rejectWizardSourceSnapshot,
  restoreSnapshotFault,
} from "#e2e/helpers/source-server-snapshot-fault";

const MARKER = "E2E_SSH_VERSION_POLICY";
const scenario = process.env.R3_VERSION_POLICY_CASE ?? "manual-required";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-version-policy",
);

describe(`${MARKER}: 版本兼容策略`, () => {
  let runtimeConfig: ReturnType<typeof readSSHRuntimeConfig> | undefined;
  const facts: Record<string, unknown> = {
    scenario,
    fixture: "synthetic-version-metadata-current-runtime",
  };
  after(async () => {
    await restoreSnapshotFault();
    if (runtimeConfig) {
      const current = await runSSHCommand(runtimeConfig, 'cat "$HOME/.zcode/server/current.json"');
      if (current.code === 0) facts.finalInstalledVersion = JSON.parse(current.stdout).version;
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "version-policy.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it(`SSH-GUIDE-VERSION ${scenario}: 当前版本策略与操作入口一致`, async function () {
    this.timeout(15 * 60_000);
    if (
      ![
        "manual-required",
        "snapshot-failure-required",
        "automatic-required",
        "optional",
        "controller-required",
      ].includes(scenario)
    )
      throw new Error("未知兼容场景");
    const config = readSSHRuntimeConfig(MARKER);
    runtimeConfig = config;
    await prepareV4ConversationE2E({ skipProvider: true });
    const a = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const b = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[1],
    });
    const sourceId = parseRemoteWorkspaceIdentity(a.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error("缺少设备身份");
    const before = JSON.parse(
      (await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout,
    );
    facts.originalInstalledVersion = before.version;
    await disconnectRemoteSource(sourceId, MARKER);
    const requiredOld = scenario.endsWith("required") && scenario !== "controller-required";
    const version = requiredOld ? "3.14.0" : "3.16.0";
    const minimum =
      scenario === "controller-required" ? "3.16.0" : requiredOld ? "3.14.0" : "3.15.0";
    const archive = await prepareVersionPolicyArchive({
      installedSha: before.archiveSha256,
      version,
      minimum,
    });
    const fixtureRoot = `${config.workspacePaths[0]}/.zcode-e2e/version-policy`;
    const remoteArchive = `${fixtureRoot}/version.tar.gz`;
    expect((await runSSHCommand(config, `mkdir -p '${fixtureRoot}'`)).code).toBe(0);
    await uploadSSHFixtureFile(config, archive, remoteArchive);
    const installed = await runSSHCommand(
      config,
      `"$HOME/.zcode/server/bin/zcode" update --from-archive '${remoteArchive}' --force --json`,
      { timeoutMs: 120_000 },
    );
    facts.syntheticInstallResult = {
      code: installed.code,
      stdout: installed.stdout,
      stderr: installed.stderr,
    };
    expect(installed.code).toBe(0);
    // Server 生命周期日志可能先于结果写到 stdout；沿用真实 SSH CLI 验证脚本的末行 JSON 合同。
    expect(JSON.parse(installed.stdout.trim().split("\n").at(-1)!).applied).toBe(true);
    const synthetic = JSON.parse(
      (await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout,
    );
    expect(synthetic.version).toBe(version);
    facts.syntheticVersion = { version, minimum, archiveSha256: synthetic.archiveSha256 };

    if (scenario === "automatic-required") {
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForRendererAfterColdRestart(MARKER);
      await browser.waitUntil(
        async () =>
          /需要处理|Needs attention/iu.test(await browser.execute(() => document.body.innerText)),
        { timeout: 120_000 },
      );
      expect(await $('[data-testid="ssh-dialog"]').isExisting()).toBe(false);
      expect(
        JSON.parse((await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout)
          .version,
      ).toBe(version);
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>("[data-settings-content-frame] button"),
            ).find(
              (item) =>
                /^(立即更新|更新|更新远端|Update now|Update|Update server)$/iu.test(
                  item.innerText.trim(),
                ) && !item.disabled,
            );
            button?.click();
            return Boolean(button);
          }),
        { timeout: 15_000, timeoutMsg: `${MARKER}: 设置页没有必须更新入口` },
      );
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    } else {
      if (scenario === "snapshot-failure-required") await holdWizardSourceSnapshot();
      await requestRemoteProjectConnection(b.workspaceIdentity!, MARKER);
    }

    if (scenario === "snapshot-failure-required") {
      const failure = `${MARKER}: snapshot temporarily unavailable`;
      const rejectedReads = await rejectWizardSourceSnapshot(failure);
      expect(await readSnapshotFaultUpdateCalls()).toBe(0);
      const actions = await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-error"] button'))
          .filter((button) => !button.disabled)
          .map((button) => button.innerText.trim()),
      );
      expect(actions.some((label) => /^(更新远端|Update server)$/iu.test(label))).toBe(false);
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(resolve(artifactDir, "snapshot-failure.png"));
      const retried = await browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-error"] button'),
        ).find((item) => /^(重试|Retry)$/iu.test(item.innerText.trim()) && !item.disabled);
        button?.click();
        return Boolean(button);
      });
      expect(retried).toBe(true);
      facts.snapshotFailure = { message: failure, rejectedReads, actions, retried };
    }

    if (scenario === "controller-required") {
      // 当前横幅引导用户查看详情；未展开时只扫描主页会遗漏真实升级原因。
      const banner = $('[data-testid="remote-conversation-banner"]');
      await browser.waitUntil(
        async () => /需要处理|Needs attention/iu.test(await banner.getText()),
        { timeout: 120_000, timeoutMsg: `${MARKER}: 桌面版本门禁没有显示处理入口` },
      );
      await banner
        .$('.//button[normalize-space(.)="详细信息" or normalize-space(.)="Details"]')
        .click();
      const details = $('[role="dialog"]');
      await details.waitForDisplayed();
      const technical = details.$("details > summary");
      if (await technical.isDisplayed()) await technical.click();
      await browser.waitUntil(
        async () => {
          const text = await details.getText();
          facts.controllerGuidance = text;
          return /更新桌面端|升级.*(?:本机|桌面)|(?:本机|桌面).*升级|(?:update|upgrade).*desktop|desktop.*(?:update|upgrade)/iu.test(
            text,
          );
        },
        { timeout: 30_000, timeoutMsg: `${MARKER}: 详细信息没有说明需要升级桌面端` },
      );
      expect(
        JSON.parse((await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout)
          .archiveSha256,
      ).toBe(synthetic.archiveSha256);
      facts.remoteNotDowngraded = true;
    } else {
      const restoredB = await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: b.workspaceIdentity!,
        expectedPath: b.workspacePath!,
        requireActive: false,
        timeoutMs: 180_000,
      });
      if (scenario === "automatic-required") {
        // F5：冷启动只恢复活动 B，A 仍保留项目入口，更新后通过真实入口按需打开。
        await openWorkspaceDraftFromSidebar(a.workspacePath!);
      }
      const restoredA = await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: a.workspaceIdentity!,
        expectedPath: a.workspacePath!,
        requireActive: false,
      });
      // 原项目手动升级不补点更新；后台冷启动分支另按 F5 验证 B 自动恢复、A 按需打开。
      expect(restoredB.remoteSessionId).not.toBe(b.remoteSessionId);
      expect(restoredA.remoteSessionId).not.toBe(a.remoteSessionId);
      facts.restoredProjects = [restoredA, restoredB];
      if (scenario === "snapshot-failure-required") {
        facts.snapshotRetryUpdateCalls = await readSnapshotFaultUpdateCalls();
        expect(facts.snapshotRetryUpdateCalls).toBe(1);
      }
      const current = JSON.parse(
        (await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout,
      );
      // 当前构建已是 3.15.1；升级目标应回到本轮真实首装版本，不能硬编码历史补丁号。
      expect(current.version).toBe(scenario === "optional" ? version : before.version);
      if (scenario === "optional") {
        expect(await $('[data-testid="ssh-dialog"]').isExisting()).toBe(false);
        expect(await $("#zcode-toast-host").getText()).not.toMatch(/更新|update/iu);
        await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
        await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
        // 设置页挂载后异步读取兼容状态；卡片出现不代表更新投影已到达。
        await browser.waitUntil(
          async () => {
            const text = await $(`[data-source-server-card="${sourceId}"]`).getText();
            facts.optionalPanelText = text;
            return /更新|update/iu.test(text);
          },
          { timeout: 30_000, timeoutMsg: `${MARKER}: 兼容的新版本没有出现可延后的更新提示` },
        );
        const deferred = await browser.execute((id) => {
          const card = document.querySelector(`[data-source-server-card="${id}"]`);
          const button = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
            (item) => /^(稍后|Later)$/iu.test(item.innerText.trim()) && !item.disabled,
          );
          button?.click();
          return Boolean(button);
        }, sourceId);
        expect(deferred).toBe(true);
        const hasLater = () =>
          browser.execute(
            (id) =>
              Array.from(
                document
                  .querySelector(`[data-source-server-card="${id}"]`)
                  ?.querySelectorAll<HTMLButtonElement>("button") ?? [],
              ).some((item) => /^(稍后|Later)$/iu.test(item.innerText.trim())),
            sourceId,
          );
        await browser.waitUntil(async () => !(await hasLater()), { timeout: 15_000 });
        await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
        await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
        await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
        expect(await hasLater()).toBe(false);
        facts.optionalDeferredAcrossPanelRemount = true;
      }
      facts.projectsRestored = true;
    }
    expect(
      (await readSettings()).sourceServers?.some((server) => server.sourceServerId === sourceId),
    ).toBe(true);
    await browser.saveScreenshot(resolve(artifactDir, `${scenario}.png`));
  });
});
