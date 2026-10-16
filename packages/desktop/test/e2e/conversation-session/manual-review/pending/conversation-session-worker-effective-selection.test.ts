import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS, encodeCustomModelValue, generateTraceId } from "@zcode/shared";
import { createWorkerSelectionIntegration } from "../../../helpers/worker-selection-integration.js";
import {
  createBotsServiceHarness,
  createFeishuConfig,
} from "../../../bots/helpers/bots-service-harness.js";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import {
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
  E2E_PLAN_NON_DEFAULT_MODEL,
} from "../../../helpers/model-provider-restart.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_THOUGHT_LEVEL,
} from "../../../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  switchV4Model,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";

const profileName = "e2e-worker-account-reviewer";
const parentMarker = "E2E_W99_EXPLICIT_PARENT";
const childMarker = "E2E_W99_EXPLICIT_CHILD";
const finalMarker = "E2E_W99_PARENT_DONE";

describe("Todo99 Worker 有效选择真实执行", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("W99-E01: 显式子代理按 Worker 当前 Team 执行，原 profile 和父模型不变", async function () {
    this.timeout(180000);
    const paths = getE2EAppDataPaths();
    const profilePath = join(paths.storageRoot, "agents", `${profileName}.md`);
    const originalProfile = [
      "---",
      `name: ${profileName}`,
      "description: Review the requested marker with the configured account model.",
      `model: ${encodeCustomModelValue(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan, E2E_PLAN_NON_DEFAULT_MODEL)}`,
      "thoughtLevel: high",
      "tools: Read",
      "maxTurns: 1",
      "---",
      "Reply only with the requested marker.",
      "",
    ].join("\n");
    await prepareV4ConversationE2E();
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({
          kind: "team-coding-plan",
          productId: "product-team-a",
          organizationId: "org-team-a",
          projectId: "proj-team-a",
        });
        await seedBigModelOAuthCredential();
        await mkdir(join(paths.storageRoot, "agents"), { recursive: true });
        await writeFile(profilePath, originalProfile, "utf8");
      },
    });
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);
    await sendV4PromptAndWaitAccepted(
      `${parentMarker}: Use Agent with subagent_type ${profileName}, then report the result.`,
      parentMarker,
      "父会话没有接纳输入",
    );
    await waitForV4AssistantMessageContaining(finalMarker);

    // 读取真正 adapter 写出的 model-io，不用 helper 返回值冒充 child 请求。
    const records = await readModelIoRecords();
    const child = records.find(
      (record) =>
        record.querySource === "subagent" && JSON.stringify(record.request).includes(childMarker),
    );
    expect(child?.model).toEqual({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      modelId: E2E_PLAN_NON_DEFAULT_MODEL,
    });
    expect(child?.request.body).toMatchObject({
      model: E2E_PLAN_NON_DEFAULT_MODEL,
      output_config: { effort: "high" },
    });
    expect(child?.error).toBeUndefined();
    const parent = records.filter(
      (record) =>
        record.querySource === "main_turn" && JSON.stringify(record.request).includes(parentMarker),
    );
    expect(parent.length).toBeGreaterThanOrEqual(2);
    expect(parent.every((record) => record.model.providerId === UPSTREAM_PROVIDER_ID)).toBe(true);
    expect(await readFile(profilePath, "utf8")).toBe(originalProfile);
  });

  it("W99-E02/03/06: 绑定 Bot 的下一轮、附件和立即设置贯穿真实 Host/Worker", async function () {
    this.timeout(180000);
    const host = await createWorkerSelectionIntegration();
    try {
      const original = {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        modelId: E2E_PLAN_NON_DEFAULT_MODEL,
        options: { reasoningLevel: "high" },
      };
      const effective = {
        ...original,
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      };
      const created = await host.task.createTask({
        workspacePath: host.workspacePath,
        modelSelection: original,
        deferPersistenceUntilFirstPrompt: true,
      });
      const target = { workspacePath: host.workspacePath, sessionId: created.taskId };
      const harness = createBotsServiceHarness({
        config: createFeishuConfig(),
        state: {
          version: 3,
          bots: {
            "feishu-e2e": {
              botId: "feishu-e2e",
              workspacePath: host.workspacePath,
              mode: "task",
              activeTaskId: created.taskId,
              updatedAt: 1,
            },
          },
        },
        modelSelectionService: host.modelSelectionService,
      });
      // 只替换测试 harness 的 task port；以下读取、命令、发送、订阅均为生产 adapter。
      Object.assign(harness.zcodeTaskService, host.task);
      const sendBot = (text: string) =>
        harness.service.handleInboundMessage({
          botId: "feishu-e2e",
          actor: {
            provider: "feishu",
            botId: "feishu-e2e",
            providerUserId: "ou_e2e_user",
            chatType: "private",
          },
          text,
        });
      const debugDir = join(host.home, ".zcode/cli/debug");
      async function waitRequest(marker: string) {
        let result: ModelIoRecord | undefined;
        await browser.waitUntil(
          async () => {
            result = (await readModelIoRecords(debugDir)).find(
              (record) =>
                record.querySource === "main_turn" &&
                JSON.stringify(record.request).includes(marker),
            );
            return Boolean(result);
          },
          { timeout: 30000, timeoutMsg: `缺少真实请求 ${marker}` },
        );
        await browser.waitUntil(
          async () => (await host.agent.readSession(target)).session.status === "idle",
          { timeout: 15000, timeoutMsg: "上一轮没有结束" },
        );
        return result!;
      }
      try {
        await host.task.sendPrompt({
          taskId: created.taskId,
          content: "E2E_W99_BOT_INITIAL",
          traceId: generateTraceId("w99"),
          modelSelection: original,
        });
        expect((await waitRequest("E2E_W99_BOT_INITIAL")).model.providerId).toBe(
          original.providerId,
        );
        await host.selectAccount(effective.providerId);
        expect(await host.task.getTaskModelSelection({ taskId: created.taskId })).toEqual(original);
        await sendBot("E2E_W99_BOT_NEXT");
        const next = await waitRequest("E2E_W99_BOT_NEXT");
        expect(next.model.providerId).toBe(effective.providerId);
        expect(next.request.body).toMatchObject({ output_config: { effort: "high" } });
        expect(harness.readState().bots["feishu-e2e"]?.draftOptions).toBeUndefined();

        await sendBot(`/model ${encodeCustomModelValue(effective.providerId, effective.modelId)}`);
        expect(
          (await host.task.getTaskModelSelection({ taskId: created.taskId }))?.options
            ?.reasoningLevel,
        ).toBe("max");
        // 单独设置档位是已提交的 Session 命令，必须立刻保存，不等下一条消息。
        await sendBot("/think low");
        expect(await host.task.getTaskModelSelection({ taskId: created.taskId })).toEqual({
          ...effective,
          options: { reasoningLevel: "low" },
        });
        // 真正退出 Worker 再恢复，不能只靠同进程内存读证明立即持久化。
        await host.agent.disposeWorkspace({ workspacePath: host.workspacePath });
        await host.task.resumeTask({ taskId: created.taskId, workspacePath: host.workspacePath });
        expect(await host.task.getTaskModelSelection({ taskId: created.taskId })).toEqual({
          ...effective,
          options: { reasoningLevel: "low" },
        });
        await expect(
          host.task.setModel({
            taskId: created.taskId,
            traceId: generateTraceId("w99"),
            modelSelection: { ...effective, options: { reasoningLevel: "invalid" } },
          }),
        ).rejects.toThrow();
        expect(
          (await host.task.getTaskModelSelection({ taskId: created.taskId }))?.options
            ?.reasoningLevel,
        ).toBe("low");

        // Session 当前 low；本次已固定 high，附件分支不能退回旧 Session 选择。
        await host.task.sendPrompt({
          taskId: created.taskId,
          content: "E2E_W99_ATTACHMENT",
          traceId: generateTraceId("w99"),
          modelSelection: effective,
          modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
          attachments: [
            {
              kind: "file",
              filename: "first.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
              textContent: "FIRST",
            },
            {
              kind: "file",
              filename: "second.txt",
              mimeType: "text/plain",
              sizeBytes: 6,
              textContent: "SECOND",
            },
          ],
        });
        const attached = await waitRequest("E2E_W99_ATTACHMENT");
        expect(attached.model.providerId).toBe(effective.providerId);
        expect(attached.request.body).toMatchObject({ output_config: { effort: "high" } });
        const body = JSON.stringify(attached.request.body);
        expect(body.indexOf("FIRST")).toBeGreaterThanOrEqual(0);
        expect(body.indexOf("SECOND")).toBeGreaterThan(body.indexOf("FIRST"));
        expect(attached.error).toBeUndefined();
        expect(
          (await host.task.getTaskModelSelection({ taskId: created.taskId }))?.options
            ?.reasoningLevel,
        ).toBe("low");
      } finally {
        harness.service.disposeAll();
      }
    } finally {
      await host.dispose();
    }
  });

  it("W99-E04: Worker 保留完整旧状态时明确拒绝新选择，交付后新提交可执行", async function () {
    this.timeout(90000);
    const host = await createWorkerSelectionIntegration();
    let frameListener: { dispose(): void } | undefined;
    try {
      const original = {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        modelId: E2E_PLAN_NON_DEFAULT_MODEL,
        options: { reasoningLevel: "high" },
      };
      const effective = {
        ...original,
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      };
      const created = await host.task.createTask({
        workspacePath: host.workspacePath,
        modelSelection: original,
        deferPersistenceUntilFirstPrompt: true,
      });
      const target = { workspacePath: host.workspacePath, sessionId: created.taskId };
      await host.task.sendPrompt({
        taskId: created.taskId,
        content: "E2E_W99_LAG_INITIAL",
        traceId: generateTraceId("w99"),
        modelSelection: original,
      });
      await browser.waitUntil(
        async () => {
          const snapshot = await host.agent.readSession(target);
          return snapshot.session.status === "idle" && snapshot.messages.length > 0;
        },
        { timeout: 30000, timeoutMsg: "旧状态初始执行未完成" },
      );
      await host.setDeliveryPaused(true);
      await host.selectAccount(effective.providerId);
      expect(
        (await host.modelSelectionService.getView({ selection: original })).effectiveSelection,
      ).toEqual(effective);
      const frames: unknown[] = [];
      frameListener = host.agent.onDynamicConversationFrame(target)((frame) => frames.push(frame));
      await host.agent.subscribeConversationV4(target);
      // 命令接纳与执行失败分开：ACK 可成功，但不能等待尚未释放的交付或偷偷换模型。
      await host.task.sendPrompt({
        taskId: created.taskId,
        content: "E2E_W99_LAG_REJECT",
        traceId: generateTraceId("w99"),
        modelSelection: effective,
      });
      await browser.waitUntil(
        async () =>
          (await host.agent.readSessionEvents(target)).some(
            (event) => event.type === "turn.failed",
          ),
        { timeout: 15000, timeoutMsg: "旧 Worker 未明确报告模型执行失败" },
      );
      await browser.waitUntil(() => JSON.stringify(frames).includes('"phase":"error"'), {
        timeout: 10000,
        timeoutMsg: "桌面 V4 没有收到执行错误",
      });
      expect(
        (await readModelIoRecords(join(host.home, ".zcode/cli/debug"))).some((record) =>
          JSON.stringify(record.request).includes("E2E_W99_LAG_REJECT"),
        ),
      ).toBe(false);
      expect(await host.task.getTaskModelSelection({ taskId: created.taskId })).toEqual(original);
      await host.setDeliveryPaused(false);
      // 复用既有读取同步检查确认交付后再作新提交；没有给普通发送加等待机制。
      await host.agent.readSession(target);
      await host.task.sendPrompt({
        taskId: created.taskId,
        content: "E2E_W99_LAG_RECOVERED",
        traceId: generateTraceId("w99"),
        modelSelection: effective,
      });
      let records: ModelIoRecord[] = [];
      await browser.waitUntil(
        async () => {
          records = await readModelIoRecords(join(host.home, ".zcode/cli/debug"));
          return records.some(
            (record) =>
              record.querySource === "main_turn" &&
              JSON.stringify(record.request).includes("E2E_W99_LAG_RECOVERED") &&
              record.model.providerId === effective.providerId &&
              !record.error,
          );
        },
        { timeout: 30000, timeoutMsg: "重新提交没有发出 Team 请求" },
      );
    } finally {
      frameListener?.dispose();
      await host.dispose();
    }
  });
});

type ModelIoRecord = {
  querySource?: string;
  model: { providerId: string; modelId: string };
  request: { body?: unknown };
  error?: unknown;
};

async function readModelIoRecords(
  debugDir = join(getE2EAppDataPaths().storageRoot, "cli", "debug"),
): Promise<ModelIoRecord[]> {
  const records: ModelIoRecord[] = [];
  for (const file of await readdir(debugDir).catch(() => [])) {
    if (!file.startsWith("model-io-") || !file.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(debugDir, file), "utf8")).split("\n")) {
      if (line.trim()) records.push(JSON.parse(line) as ModelIoRecord);
    }
  }
  return records;
}
