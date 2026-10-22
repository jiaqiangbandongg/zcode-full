import { selectTaskOrganizeMode } from "../../../helpers/workspace-agent-warmup.js";
import {
  openRemoteProjectSelection,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  selectSSHRemoteDirectory,
} from "#e2e/helpers/ssh-remote-p0";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_DOCKER_CONTAINER_INPUT, TID_REMOTE_KIND_DOCKER } from "@zcode/shared/test-ids";
import { ApiKeyAccessConfig, ProviderApiConfig, ProviderConfig } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import { refreshSeededOpenAIProvidersThroughSettings } from "../../../helpers/custom-openai-provider.js";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "../../../helpers/upstream-provider.js";
import { getUpstreamRequestRecordCount } from "../../../helpers/conversation-session-network.js";
import {
  clickLastEnabledSSHDialogButton,
  readHostProcesses,
  readRemoteTabSnapshot,
} from "../../../helpers/ssh-remote-p0.js";
import {
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4ConversationState,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_R3_DOCKER_TRANSPORT";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-docker-transport",
);
const LIVE_PROVIDER_ID = "e2e-r3-docker-live-zapi";
const LIVE_PROVIDER_NAME = "R3 Docker Live ZAPI";
const LIVE_MODEL_ID = "GLM-5.3";
const USER_ZAPI_PROVIDER_ID = "84916fff-3839-4e1c-a59d-64923669a665";
const run = promisify(execFile);

async function dockerSh(container: string, command: string): Promise<string> {
  try {
    return (await run("docker", ["exec", container, "sh", "-lc", command], { maxBuffer: 1 << 22 }))
      .stdout;
  } catch (error) {
    return `ERR:${(error as { stderr?: string }).stderr ?? String(error)}`;
  }
}

/** 与 LIVE-01 同源：只从本机正式 Personal 配置读取 ZAPI（内存），容器无法访问本机回放服务，首发用真实模型。 */
async function seedLiveZapiProvider(): Promise<{ baseURL: string }> {
  const sourcePath = process.env.R3_LIVE_PERSONAL_CONFIG?.trim();
  if (!sourcePath) throw new Error(`${CASE_MARKER}: 需设置 R3_LIVE_PERSONAL_CONFIG`);
  // 0911 修复（与 r3-live-zapi 同源）：本机配置已迁移新 schema（schemaVersion:1,
  // config.providerConfigRules），旧手读 raw.providers[<id>] 得 undefined → TypeError。
  // 改走正式 repository.read() 归一新旧 schema；材料缺失时报可读错误。
  const sourceRepository = new NodePersonalProviderConfigRepository({
    filePath: sourcePath,
    pollingIntervalMs: false,
  });
  let sourceApiKey: string | undefined;
  let sourceBaseUrl: string | undefined;
  let sourceApiType: string | undefined;
  try {
    const snapshot = await sourceRepository.read();
    const rule = snapshot.providers.getRule(USER_ZAPI_PROVIDER_ID);
    // access 是 api-key / zhipu-account 联合类型，只有 api-key 形态才有 apiKey；
    // snapshot 字段可能为 null（显式清空），统一归一成 undefined 走下方缺失判定。
    const access = rule?.config.access;
    sourceApiKey = access?.type === "api-key" ? (access.apiKey ?? undefined) : undefined;
    sourceBaseUrl = rule?.config.api?.baseUrl ?? undefined;
    sourceApiType = rule?.config.api?.type ?? undefined;
  } finally {
    sourceRepository.dispose();
  }
  if (!sourceApiKey || sourceApiType !== "anthropic-messages" || !sourceBaseUrl) {
    throw new Error(
      `${CASE_MARKER}: 本机 ZAPI provider（${USER_ZAPI_PROVIDER_ID}, anthropic-messages）配置不可用——live 材料缺失，需在本机 Personal 配置中导入 ZAPI provider`,
    );
  }
  const repository = new NodePersonalProviderConfigRepository({
    filePath: getE2EAppDataPaths().configFile,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      providers: current.providers.setRule({
        providerId: LIVE_PROVIDER_ID,
        providerName: LIVE_PROVIDER_NAME,
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: sourceApiKey }),
          api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl: sourceBaseUrl }),
          personalModelIds: [LIVE_MODEL_ID],
        }),
      }),
      models: current.models,
    }));
  } finally {
    repository.dispose();
  }
  return { baseURL: sourceBaseUrl };
}

async function connectDockerTargetUntilReady(
  container: string,
): Promise<{ identity: string; remoteSessionId: string; kind: string | null }> {
  // Composer 的旧远程入口已退役；与 SSH 一样从项目创建进入 transport 选择。
  await openRemoteProjectSelection();
  await clickTestIdByDom(TID_REMOTE_KIND_DOCKER, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 无法选择 Docker transport`,
  });
  const input = $(`[data-testid="${TID_DOCKER_CONTAINER_INPUT}"]`);
  await input.waitForDisplayed({ timeout: 30_000 });
  await input.setValue(container);
  await clickLastEnabledSSHDialogButton(CASE_MARKER);
  await waitForSSHDirectoryStep(CASE_MARKER);
  const workspacePath = process.env.ZCODE_E2E_SSH_WORKSPACE_PATH;
  if (!workspacePath) throw new Error(`${CASE_MARKER}: 缺少 Docker 项目目录`);
  await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
  const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: workspacePath });
  return {
    identity: tab.workspaceIdentity!,
    remoteSessionId: tab.remoteSessionId!,
    kind: tab.remoteKind,
  };
}

describe(`${CASE_MARKER}: Desktop Docker transport 首装、首发与关闭重连`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "docker-transport.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-TRN-01 独立 Docker 容器：Docker 入口安装、Provisioning、真实首发、断开后重连", async function () {
    this.timeout(30 * 60_000);
    const container = process.env.R3_DOCKER_TARGET?.trim();
    if (!container) throw new Error(`${CASE_MARKER}: 需设置 R3_DOCKER_TARGET`);
    facts.container = container;
    facts.containerUser = (
      await dockerSh(
        container,
        "id -un; test -e ~/.zcode/server/current.json && echo installed || echo fresh",
      )
    ).trim();
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    const seeded = await seedLiveZapiProvider();
    await refreshSeededOpenAIProvidersThroughSettings([LIVE_PROVIDER_NAME]);

    const ready = await connectDockerTargetUntilReady(container);
    facts.ready = ready;
    expect(ready.kind).toBe("docker");
    const parsed = parseRemoteWorkspaceIdentity(ready.identity);
    expect(parsed?.kind).toBe("server");
    // 0911 修复：远端 provider_config.json 已迁移新 schema（providerRules[].providerName），
    // 旧字段 "label" 不存在 → grep 无匹配 exit 1 且 stderr 为空 → dockerSh 返回裸 "ERR:"，
    // 掩盖了前两段（archiveSha256/state:ready）的真实输出。改为 grep providerName，
    // 且每段 grep 兜底 || true，保证命令 exit 0 时 stdout 不被丢弃。
    const installState = await dockerSh(
      container,
      'grep -o \'"archiveSha256": *"[0-9a-f]*"\' ~/.zcode/server/current.json || true; cat ~/.zcode/server/run/status.json | tr -d "\\n "; echo; grep -o "\\"providerName\\": *\\"[^\\"]*\\"" ~/.zcode/v2/provider_config.json || true',
    );
    facts.remoteAfterConnect = installState.split("\n").filter(Boolean).slice(0, 8);
    expect(installState).toContain("archiveSha256");
    expect(installState).toContain('"state":"ready"');
    expect(installState).toContain(LIVE_PROVIDER_NAME);
    expect(await readHostProcesses()).toEqual(initialHosts);

    // 真实首发：容器内 Agent 直连 ZAPI。
    await selectUpstreamProviderModelById(LIVE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: LIVE_PROVIDER_ID,
      providerName: LIVE_PROVIDER_NAME,
    });
    await selectUpstreamThoughtLevelValue("low");
    // 复用 Docker 项目草稿，保留当前机器与模型归属。
    const replayBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_FIRST 请只回复 DOCKER1`,
      `${CASE_MARKER}_FIRST`,
      `${CASE_MARKER}: 首发未被接受`,
    );
    const running = await waitForV4ConversationState(
      (s) => Boolean(s.taskId && s.taskId !== "draft"),
      `${CASE_MARKER}: 首发没有产生 task`,
      60_000,
    );
    await waitForV4ConversationState(
      (s) => s.taskId === running.taskId && s.state === "idle" && s.queueCount === 0,
      `${CASE_MARKER}: 真实首发没有收口`,
      180_000,
    );
    // 用户 prompt 本身含 DOCKER1，不能用整个页面文本作为真实回复证据。
    await browser.waitUntil(
      async () =>
        (await getV4Messages("assistant")).some((message) =>
          /DOCKER\s*1/u.test(message.text ?? ""),
        ),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: assistant 未返回 DOCKER1` },
    );
    const text = (await getV4Messages("assistant")).map((message) => message.text ?? "").join("\n");
    expect(text).toMatch(/DOCKER\s*1/u);
    expect(await getUpstreamRequestRecordCount()).toBe(replayBefore);
    const remoteRequests = await dockerSh(
      container,
      'F=$(ls -t ~/.zcode/cli/log/*.jsonl | head -n1); grep -c "model.network.completed" "$F" || true; grep -o "\\"baseURL\\":\\"[^\\"]*\\"" "$F" | sort | uniq -c',
    );
    facts.remoteModelNetwork = remoteRequests.trim().split("\n");
    expect(remoteRequests).toContain(seeded.baseURL);

    // 关闭重连：设备断开 → 重连 → 新 remoteSessionId、Host 不变、容器内 daemon 仍在。
    const sourceId = parsed?.sourceServerId;
    await selectTaskOrganizeMode(["项目", "Project"]);

    await disconnectRemoteSource(sourceId!, CASE_MARKER, { workspaceIdentities: [ready.identity] });

    const daemonAfterDisconnect = await dockerSh(
      container,
      'cat ~/.zcode/server/run/status.json | tr -d "\\n " | cut -c1-120',
    );
    expect(daemonAfterDisconnect).toContain('"state":"ready"');
    await reconnectRemoteProject(ready.identity, CASE_MARKER);
    let reconnected: string | null = null;
    await browser.waitUntil(
      async () => {
        const snapshot = await readRemoteTabSnapshot(ready.identity).catch(() => null);
        if (snapshot?.remoteSessionId && snapshot.remoteSessionId !== ready.remoteSessionId) {
          reconnected = snapshot.remoteSessionId;
          return true;
        }
        return false;
      },
      { timeout: 180_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: Docker 目标重连没有换代` },
    );
    facts.reconnected = { before: ready.remoteSessionId, after: reconnected };
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});
