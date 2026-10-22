import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { prepareSourceServerUpdateArchive } from "#e2e/helpers/source-server-update-fixture";
import {
  connectRemoteSourceFromSettings,
  disconnectRemoteSource,
} from "#e2e/helpers/remote-project-actions";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData, switchToNewestWindow } from "../../../helpers/desktop-app.js";
import {
  connectSSHWorkspace,
  runSSHCommand,
  readSingleSSHWorkspaceRuntimeConfig,
  waitForSSHDirectoryStep,
} from "../../../helpers/ssh-remote-p0.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_REMOTE_INSTALL_PROGRESS";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-install-progress",
);

interface Observation {
  phase: string;
  failedSubtitle: boolean;
  percentage: string | null;
}
type ObservedWindow = Window & {
  __installObservations?: Observation[];
  __duplicateUpdateToasts?: string[];
  __installObserver?: MutationObserver;
};

describe(`${CASE_MARKER}: 远端安装真实阶段`, () => {
  after(async () => {
    const observations = await browser.execute(() => {
      const state = window as ObservedWindow;
      state.__installObserver?.disconnect();
      return {
        phases: state.__installObservations ?? [],
        duplicateUpdateToasts: state.__duplicateUpdateToasts ?? [],
      };
    });
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "install-progress.json"),
      JSON.stringify(observations, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RDUX-16 自动更新时显示实时校验与重启，随后进入目录选择", async function () {
    this.timeout(10 * 60_000);
    // 只允许 harness 的独立目标；在本 case 内真实首装，再制造同版本新 SHA 验证更新。
    expect(process.env.ZCODE_E2E_SSH_CONTAINER).toMatch(
      /^zcode-(?:progress-e2e-|r3-server-[a-f0-9]{16}-)/u,
    );
    const config = readSingleSSHWorkspaceRuntimeConfig(CASE_MARKER);
    // 隔离 HOME 首次进入职业引导；先退出引导，再使用已有 workspace 准备链。
    await browser.waitUntil(
      async () => {
        await switchToNewestWindow();
        return (
          (await $('[data-testid="onboarding-page"]').isDisplayed()) ||
          (await $('[data-testid^="v4-session-pane-"]').isDisplayed())
        );
      },
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 首次引导或工作区未出现` },
    );
    if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
    await prepareV4ConversationE2E({ skipProvider: true });
    const initial = await connectSSHWorkspace({
      config,
      caseMarker: CASE_MARKER,
      workspacePath: config.workspacePath,
    });
    const sourceId = parseRemoteWorkspaceIdentity(initial.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 首装缺少 Source 身份`);
    const installed = await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"');
    const oldSha = JSON.parse(installed.stdout).archiveSha256 as string;
    await disconnectRemoteSource(sourceId, CASE_MARKER);
    const update = await prepareSourceServerUpdateArchive(oldSha, CASE_MARKER);
    expect(update.newSha).not.toBe(update.oldSha);

    await browser.execute(() => {
      const state = window as ObservedWindow;
      state.__installObservations = [];
      state.__duplicateUpdateToasts = [];
      const capture = () => {
        // 从连接发起前持续观察，捕获 needs-upgrade 到 updating 之间短暂出现的重复按钮。
        const toastHost = document.querySelector<HTMLElement>("#zcode-toast-host");
        if (
          [...(toastHost?.querySelectorAll("button") ?? [])].some((button) =>
            /^(立即更新|Update now)$/iu.test(button.textContent?.trim() ?? ""),
          )
        ) {
          const text = toastHost?.innerText ?? "";
          if (!state.__duplicateUpdateToasts?.includes(text))
            state.__duplicateUpdateToasts?.push(text);
        }
        const dialog = document.querySelector<HTMLElement>('[data-testid="ssh-dialog"]');
        const active = dialog?.querySelector<HTMLElement>("ol > li.bg-surface");
        const phase = active?.querySelector("p")?.textContent?.trim() ?? "";
        if (!phase) return;
        const observation = {
          phase,
          failedSubtitle: /连接失败 ·|Connection failed ·/u.test(dialog?.innerText ?? ""),
          percentage:
            active?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") ?? null,
        };
        const previous = state.__installObservations?.at(-1);
        if (JSON.stringify(previous) !== JSON.stringify(observation))
          state.__installObservations?.push(observation);
      };
      state.__installObserver = new MutationObserver(capture);
      state.__installObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    });
    await connectRemoteSourceFromSettings(sourceId, CASE_MARKER);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          Boolean(
            (window as ObservedWindow).__installObservations?.some(
              (item) => item.phase === "正在校验服务文件",
            ),
          ),
        ),
      { timeout: 300_000, interval: 200, timeoutMsg: `${CASE_MARKER}: 未实时显示整目录校验` },
    );
    await mkdir(artifactDir, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await browser.execute((value) => {
        const actions = (window as Window & { __testActions?: { setTheme(value: string): void } })
          .__testActions;
        if (!actions) throw new Error("Missing theme test actions");
        actions.setTheme(value);
      }, theme);
      for (const width of [1400, 480]) {
        await browser.electron.execute((electron, nextWidth) => {
          const window = electron.BrowserWindow.getAllWindows().find(
            (candidate) => !candidate.isDestroyed(),
          );
          window?.setSize(nextWidth, 900);
        }, width);
        await browser.waitUntil(
          () =>
            browser.execute((expected) => {
              const rect = document
                .querySelector("[data-testid=ssh-dialog]")
                ?.getBoundingClientRect();
              return (
                Math.abs(window.innerWidth - expected) <= 1 &&
                Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth)
              );
            }, width),
          { timeout: 5000 },
        );
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        await browser.saveScreenshot(resolve(artifactDir, `verify-${theme}-${width}.png`));
      }
    }
    // 更新结束后首连仍需边界确认；交给已有 helper 确认，再断言目录就绪。
    await browser.waitUntil(
      () => browser.execute(() => !document.querySelector("[data-testid=ssh-error]")),
      { timeout: 180_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 更新没有完成或显示错误` },
    );
    const flow = await waitForSSHDirectoryStep(CASE_MARKER);
    expect(flow).toBe("directory");
    const observations = await browser.execute(
      () => (window as ObservedWindow).__installObservations ?? [],
    );
    expect(
      await browser.execute(() => (window as ObservedWindow).__duplicateUpdateToasts ?? []),
    ).toEqual([]);
    for (const phase of [
      "正在上传安装包",
      "正在解压服务文件",
      "正在校验安装包",
      "正在校验服务文件",
      "正在重启远端服务",
    ]) {
      expect(observations.some((item) => item.phase === phase)).toBe(true);
    }
    expect(observations.every((item) => !item.failedSubtitle)).toBe(true);
    expect(
      observations
        .filter((item) => item.phase !== "正在上传安装包")
        .every((item) => item.percentage === null),
    ).toBe(true);
    await browser.saveScreenshot(resolve(artifactDir, "directory-ready.png"));
  });
});
