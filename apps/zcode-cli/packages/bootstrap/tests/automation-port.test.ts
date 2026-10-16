import { describe, expect, it, vi } from "vitest";
import { AutomationCreateLimitError, isAutomationCreateLimitError } from "@zcode/contracts";
import { AUTOMATION_CREATE_LIMIT_ERROR_CODE, isHighspeedProviderId, zcodeProtocolMethods } from "@zcode/shared";
import {
  AUTOMATION_CREATE_BOUND_SESSION_CHECK_ERROR,
  AUTOMATION_CREATE_FROM_AUTOMATION_RUN_ERROR,
  AUTOMATION_CREATE_IN_BOUND_SESSION_ERROR,
  createProtocolAutomationPort,
} from "../src/zcode-protocol/automation-port.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "../src/zcode-protocol/server-types.js";

describe("createProtocolAutomationPort", () => {
  it("拒绝 automation 执行 turn 里再次 CronCreate，且不调用 automation/create", async () => {
    const requestClient = vi.fn();
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map([
        [
          "session-1",
          {
            activeAutomationId: "automation-parent",
            app: {
              runtime: {
                getSessionModelSelection: () => ({ providerId: "zai-api", modelId: "GLM-5" }),
              },
              getModel: () => "zai-api/GLM-5",
              getMode: () => "yolo",
              getThoughtLevel: () => "nothink",
              setCustomSessionTitle: vi.fn(async () => undefined),
            },
            traceContext: { traceId: "trace-session-1" },
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext);

    await expect(
      port.create(
        {
          cron: "*/5 * * * *",
          delayMinutes: null,
          prompt: "nested",
          title: "nested",
        },
        { sessionId: "session-1" },
      ),
    ).rejects.toThrow(AUTOMATION_CREATE_FROM_AUTOMATION_RUN_ERROR);
    expect(requestClient).not.toHaveBeenCalled();
  });

  it("拒绝在已归属定时任务的会话里再次 CronCreate（按 targetTaskId 兜底），且不调用 automation/create", async () => {
    // Bugfix 回归：桌面交互输入直连 CLI，绕过 host adapter 的 toolDenylist 注入；用户在一个已归属
    // 定时任务的会话里继续输入时，CronCreate 仍会被注册。这里在创建入口按 targetTaskId 兜底拒绝。
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) {
        return { bound: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map([
        [
          "session-1",
          {
            app: {
              runtime: { getSessionModelSelection: () => undefined },
              getModel: () => undefined,
              getMode: () => undefined,
              getThoughtLevel: () => undefined,
              setCustomSessionTitle: vi.fn(async () => undefined),
            },
            traceContext: { traceId: "trace-session-1" },
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext);

    await expect(
      port.create(
        {
          cron: "*/5 * * * *",
          delayMinutes: null,
          prompt: "再帮我建一个",
          title: "再帮我建一个",
        },
        { sessionId: "session-1" },
      ),
    ).rejects.toThrow(AUTOMATION_CREATE_IN_BOUND_SESSION_ERROR);
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCheckTaskBinding,
      { targetTaskId: "session-1" },
      expect.anything(),
    );
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.automationList,
      expect.anything(),
      expect.anything(),
    );
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([undefined, "yolo", "guarded"] as const)(
    "普通会话创建 automation 保留显式模式 %s，不迁移未设置值",
    async (mode) => {
      const requestClient = vi.fn(async (method: string) => {
        if (method === zcodeProtocolMethods.automationCheckTaskBinding) return { bound: false };
        if (method === zcodeProtocolMethods.automationCreate) {
          return {
            automation: {
              automationId: "automation-new",
              title: "每5分钟提醒",
              cronExpr: "*/5 * * * *",
              prompt: "提醒我",
              enabled: true,
              lifecycleStatus: "active" as const,
              runCount: 0,
              recurring: true,
              mode,
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      });
      const port = createProtocolAutomationPort({
        requestClient,
        sessions: new Map([
          [
            "session-1",
            {
              app: {
                runtime: { getSessionModelSelection: () => undefined },
                getModel: () => undefined,
                getMode: () => mode,
                getThoughtLevel: () => undefined,
                setCustomSessionTitle: vi.fn(async () => undefined),
              },
              traceContext: { traceId: "trace-session-1" },
            },
          ],
        ]),
      } as unknown as ZCodeProtocolAgentServerContext);

      await expect(
        port.create(
          {
            cron: "*/5 * * * *",
            delayMinutes: null,
            prompt: "提醒我",
            title: "每5分钟提醒",
          },
          { sessionId: "session-1" },
        ),
      ).resolves.toEqual(expect.objectContaining({ automationId: "automation-new", mode }));
      expect(requestClient).toHaveBeenCalledWith(
        zcodeProtocolMethods.automationCreate,
        expect.objectContaining({ targetTaskId: "session-1", ...(mode ? { mode } : {}) }),
        expect.anything(),
      );
      expect(requestClient).not.toHaveBeenCalledWith(
        zcodeProtocolMethods.automationList,
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("CronCreate、CronUpdate 与 CronList 透传 interval carrier 并保留权威 scheduleRule", async () => {
    const minuteRule = {
      unit: "minute" as const,
      interval: 200,
      hour: 10,
      minute: 30,
      anchorAt: 1_700_000_000_000,
    };
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) return { bound: false };
      if (method === zcodeProtocolMethods.automationCreate) {
        return {
          automation: {
            automationId: "automation-interval",
            title: "每200分钟提醒",
            cronExpr: "* * * * *",
            prompt: "提醒我",
            enabled: true,
            lifecycleStatus: "active" as const,
            runCount: 0,
            recurring: true,
            scheduleRule: minuteRule,
          },
        };
      }
      if (method === zcodeProtocolMethods.automationUpdate) {
        return {
          automation: {
            automationId: "automation-interval",
            title: "每200小时的第49分提醒",
            cronExpr: "49 * * * *",
            prompt: "提醒我",
            enabled: true,
            lifecycleStatus: "active" as const,
            runCount: 0,
            recurring: true,
            scheduleRule: {
              unit: "hourly" as const,
              interval: 200,
              hour: 0,
              minute: 49,
              anchorAt: 1_700_000_060_000,
            },
          },
        };
      }
      if (method === zcodeProtocolMethods.automationList) {
        return {
          automations: [
            {
              automationId: "automation-interval",
              title: "每200小时的第49分提醒",
              cronExpr: "49 * * * *",
              prompt: "提醒我",
              enabled: true,
              lifecycleStatus: "active" as const,
              runCount: 0,
              recurring: true,
              scheduleRule: {
                unit: "hourly" as const,
                interval: 200,
                hour: 0,
                minute: 49,
                anchorAt: 1_700_000_060_000,
              },
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map([
        [
          "session-1",
          {
            app: {
              runtime: { getSessionModelSelection: () => undefined },
              getModel: () => undefined,
              getMode: () => undefined,
              getThoughtLevel: () => undefined,
              setCustomSessionTitle: vi.fn(async () => undefined),
            },
            traceContext: { traceId: "trace-session-1" },
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext);

    const created = await port.create(
      {
        cron: "* * * * *",
        delayMinutes: null,
        prompt: "提醒我",
        title: "每200分钟提醒",
        intervalUnit: "minute",
        interval: 200,
      },
      { sessionId: "session-1" },
    );
    const updated = await port.update({
      id: "automation-interval",
      cron: "49 * * * *",
      intervalUnit: "hourly",
      interval: 200,
    });
    const listed = await port.list();

    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.objectContaining({
        intervalUnit: "minute",
        interval: 200,
        recurring: true,
      }),
      expect.anything(),
    );
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationUpdate,
      expect.objectContaining({
        intervalUnit: "hourly",
        interval: 200,
        recurring: true,
        maxRuns: null,
      }),
      expect.anything(),
    );
    expect(created.scheduleRule).toEqual(minuteRule);
    expect(updated.scheduleRule).toMatchObject({ unit: "hourly", interval: 200, minute: 49 });
    expect(listed[0]?.scheduleRule).toMatchObject({ unit: "hourly", interval: 200, minute: 49 });
  });

  it("将当前 Bot turn 的回推目标注入 automation/create，普通模型输入不能自行指定", async () => {
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) return { bound: false };
      if (method === zcodeProtocolMethods.automationCreate) {
        return {
          automation: {
            automationId: "automation-bot",
            title: "Bot 日报",
            cronExpr: "0 9 * * *",
            prompt: "生成日报",
            enabled: true,
            lifecycleStatus: "active" as const,
            runCount: 0,
            recurring: true,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const botDeliveryTarget = {
      provider: "feishu" as const,
      botId: "bot-feishu",
      providerUserId: "chat-1",
      chatType: "group" as const,
    };
    const port = createProtocolAutomationPort(
      { requestClient, sessions: new Map() } as unknown as ZCodeProtocolAgentServerContext,
      () =>
        ({
          activeBotDeliveryTarget: botDeliveryTarget,
          app: {
            runtime: { getSessionModelSelection: () => undefined },
            sessionId: "session-1",
            getModel: () => undefined,
            getMode: () => undefined,
            getThoughtLevel: () => undefined,
            setCustomSessionTitle: vi.fn(async () => undefined),
          },
          traceContext: { traceId: "trace-session-1" },
        }) as never,
    );

    await port.create(
      { cron: "0 9 * * *", delayMinutes: null, prompt: "生成日报", title: "Bot 日报" },
      { sessionId: "session-1" },
    );

    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.objectContaining({ botDeliveryTarget }),
      expect.anything(),
    );
  });

  it("旧 Host 缺少归属查询方法时回退 automation/list，并允许未绑定会话 CronCreate", async () => {
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) {
        throw new ProtocolRequestError(-32601, "Method not found");
      }
      if (method === zcodeProtocolMethods.automationList) {
        return {
          automations: [
            {
              automationId: "automation-other",
              title: "其他会话任务",
              cronExpr: "0 8 * * *",
              prompt: "提醒其他会话",
              targetTaskId: "session-other",
              enabled: true,
              lifecycleStatus: "active" as const,
              runCount: 0,
              recurring: true,
            },
          ],
        };
      }
      if (method === zcodeProtocolMethods.automationCreate) {
        return {
          automation: {
            automationId: "automation-new",
            title: "每5分钟提醒",
            cronExpr: "*/5 * * * *",
            prompt: "提醒我",
            targetTaskId: "session-1",
            enabled: true,
            lifecycleStatus: "active" as const,
            runCount: 0,
            recurring: true,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    await expect(
      port.create(
        {
          cron: "*/5 * * * *",
          delayMinutes: null,
          prompt: "提醒我",
          title: "每5分钟提醒",
        },
        { sessionId: "session-1" },
      ),
    ).resolves.toEqual(expect.objectContaining({ automationId: "automation-new" }));
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationList,
      {},
      expect.anything(),
    );
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.objectContaining({ targetTaskId: "session-1" }),
      expect.anything(),
    );
  });

  it("旧 Host 回退列表命中当前会话绑定时仍拒绝 CronCreate", async () => {
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) {
        throw new ProtocolRequestError(-32601, "Method not found");
      }
      if (method === zcodeProtocolMethods.automationList) {
        return {
          automations: [
            {
              automationId: "automation-owner",
              title: "当前会话任务",
              cronExpr: "*/10 * * * *",
              prompt: "提醒当前会话",
              targetTaskId: "session-1",
              enabled: true,
              lifecycleStatus: "active" as const,
              runCount: 0,
              recurring: true,
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    await expect(
      port.create(
        {
          cron: "*/5 * * * *",
          delayMinutes: null,
          prompt: "再建一个任务",
          title: "再建一个任务",
        },
        { sessionId: "session-1" },
      ),
    ).rejects.toThrow(AUTOMATION_CREATE_IN_BOUND_SESSION_ERROR);
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.anything(),
      expect.anything(),
    );
  });

  it("相对时间通过 relativeDelayMinutes 交给 Host，模型不再计算绝对 cron", async () => {
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCreate) {
        return {
          automation: {
            automationId: "automation-relative",
            title: "3分钟后接水提醒",
            cronExpr: "47 14 28 7 *",
            prompt: "提醒我接水",
            enabled: true,
            lifecycleStatus: "active" as const,
            nextRunAt: 1_785_221_068_000,
            runCount: 0,
            recurring: false,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    await port.create({
      delayMinutes: 3,
      prompt: "提醒我接水",
      title: "3分钟后接水提醒",
      recurring: false,
    });

    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.objectContaining({
        cronExpr: "* * * * *",
        relativeDelayMinutes: 3,
        recurring: false,
      }),
      expect.anything(),
    );
  });

  it("省略 delayMinutes 的普通 cron 创建保持 recurring 默认，不误走相对分支", async () => {
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCreate) {
        return {
          automation: {
            automationId: "automation-plain",
            title: "每天9点喝水提醒",
            cronExpr: "0 9 * * *",
            prompt: "提醒我喝水",
            enabled: true,
            lifecycleStatus: "active" as const,
            runCount: 0,
            recurring: true,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    // Bug 原因：`delayMinutes !== null` 判定下，省略字段（很多 provider 不稳定保留
    // null 字段）会被误当成相对任务，把普通 recurring 调度错建成一次性。
    await port.create({
      cron: "0 9 * * *",
      prompt: "提醒我喝水",
      title: "每天9点喝水提醒",
    });

    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.objectContaining({ cronExpr: "0 9 * * *", recurring: true }),
      expect.anything(),
    );
    const createPayload = requestClient.mock.calls.find(
      ([method]) => method === zcodeProtocolMethods.automationCreate,
    )?.[1] as Record<string, unknown>;
    expect(createPayload).not.toHaveProperty("relativeDelayMinutes");
  });

  it("将完整 task mode 归一化为 Cron 工具兼容的权限模式", async () => {
    const modeCases = [
      ["default", "build"],
      ["auto", "build"],
      ["acceptEdits", "build"],
      ["autoEdit", "build"],
      ["dontAsk", "yolo"],
      ["bypassPermissions", "yolo"],
      ["build", "build"],
      ["edit", "edit"],
      ["plan", "plan"],
      ["yolo", "yolo"],
    ] as const;
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationList) {
        return {
          automations: modeCases.map(([mode], index) => ({
            automationId: `automation-${index}`,
            title: `automation ${index}`,
            cronExpr: "0 9 * * *",
            prompt: "生成晨报",
            mode,
            enabled: true,
            lifecycleStatus: "active" as const,
            runCount: 0,
            recurring: true,
          })),
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    const automations = await port.list();

    expect(automations.map(({ mode }) => mode)).toEqual(
      modeCases.map(([, expectedMode]) => expectedMode),
    );
  });

  it("将 automation/create 上限错误映射为 CLI 稳定领域错误", async () => {
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) return { bound: false };
      if (method === zcodeProtocolMethods.automationCreate) {
        throw new Error(
          `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most 20 automations may be retained.`,
        );
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    const error = await port
      .create(
        { cron: "0 9 * * *", prompt: "生成晨报", title: "每天 9 点晨报" },
        { sessionId: "session-1" },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AutomationCreateLimitError);
    expect(isAutomationCreateLimitError(error)).toBe(true);
  });

  it("automation 归属查询失败时 fail-closed，且不调用 automation/create", async () => {
    const logger = { warn: vi.fn() };
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) {
        throw new Error("automation storage unavailable");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const port = createProtocolAutomationPort({
      logger,
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    await expect(
      port.create(
        {
          cron: "*/5 * * * *",
          delayMinutes: null,
          prompt: "提醒我",
          title: "每5分钟提醒",
        },
        { sessionId: "session-unknown" },
      ),
    ).rejects.toThrow(AUTOMATION_CREATE_BOUND_SESSION_CHECK_ERROR);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to check bound automations before CronCreate",
      expect.objectContaining({
        event: "automation.create.bound_session_check.failed",
        sessionId: "session-unknown",
      }),
    );
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.automationList,
      expect.anything(),
      expect.anything(),
    );
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.anything(),
      expect.anything(),
    );
  });

  it("CronCreate 协议请求继承活跃会话的模型、权限和思考等级", async () => {
    const setCustomSessionTitle = vi.fn(async () => undefined);
    const requestClient = vi.fn(async () => ({
      automation: {
        automationId: "automation-1",
        title: "daily report",
        cronExpr: "0 9 * * *",
        prompt: "write daily report",
        model: "zai-api/GLM-5",
        provider: "glm",
        mode: "yolo" as const,
        thoughtLevel: "nothink",
        enabled: true,
        lifecycleStatus: "active" as const,
        runCount: 0,
        recurring: true,
      },
    }));
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map([
        [
          "session-1",
          {
            app: {
              runtime: {
                getSessionModelSelection: () => ({
                  providerId: "zai-api",
                  modelId: "GLM-5",
                  options: { reasoningLevel: "nothink" },
                }),
              },
              getModel: () => "zai-api/GLM-5",
              getMode: () => "yolo",
              getThoughtLevel: () => "nothink",
              setCustomSessionTitle,
            },
            traceContext: { traceId: "trace-session-1" },
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext);

    await port.create(
      {
        cron: "0 9 * * *",
        delayMinutes: null,
        prompt: "write daily report",
        title: "daily report",
      },
      { model: "stale-provider/stale-model", sessionId: "session-1" },
    );

    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      {
        cronExpr: "0 9 * * *",
        prompt: "write daily report",
        title: "daily report",
        recurring: true,
        modelSelection: {
          providerId: "zai-api",
          modelId: "GLM-5",
          options: { reasoningLevel: "nothink" },
        },
        mode: "yolo",
        targetTaskId: "session-1",
      },
      expect.anything(),
    );
    expect(setCustomSessionTitle).toHaveBeenCalledWith({
      title: "daily report",
      traceContext: { traceId: "trace-session-1" },
    });
  });

  it("Highspeed Turn 中 CronCreate 持久化加速前的会话模型", async () => {
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) return { bound: false };
      return {
        automation: {
          automationId: "automation-highspeed",
          title: "daily report",
          cronExpr: "0 9 * * *",
          prompt: "write daily report",
          model: "builtin:zai/GLM-5",
          provider: "glm",
          enabled: true,
          lifecycleStatus: "active" as const,
          runCount: 0,
          recurring: true,
        },
      };
    });
    // 加速轮的模型只存在于本轮 modelExecution（selectionScope=execution），从不写回
    // Session Selection；所以 CronCreate 读到的 Session Selection 必须仍是加速前的普通选型。
    const getSessionModelSelection = vi.fn(() => ({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5",
    }));
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map([
        [
          "session-1",
          {
            app: {
              runtime: { getSessionModelSelection },
              getMode: () => "build",
              setCustomSessionTitle: vi.fn(async () => undefined),
            },
            traceContext: { traceId: "trace-session-1" },
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext);

    await port.create(
      {
        cron: "0 9 * * *",
        delayMinutes: null,
        prompt: "write daily report",
        title: "daily report",
      },
      { sessionId: "session-1" },
    );

    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.objectContaining({
        modelSelection: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5" },
      }),
      expect.anything(),
    );
    // 定时任务禁止落库加速卡 Provider，否则后续触发会拿不到卡凭据而失败。
    const createdPayload = requestClient.mock.calls.find(
      (call) => call[0] === zcodeProtocolMethods.automationCreate,
    )?.[1] as { modelSelection?: { providerId?: string } } | undefined;
    expect(isHighspeedProviderId(createdPayload?.modelSelection?.providerId)).toBe(false);
  });

  it("CronCreate 成功后冻结当前会话标题，避免迟到 generated title 覆盖 automation 语义", async () => {
    const setCustomSessionTitle = vi.fn(async () => undefined);
    const port = createProtocolAutomationPort({
      requestClient: vi.fn(async () => ({
        automation: {
          automationId: "automation-1",
          title: "每5分钟给我讲个笑话",
          cronExpr: "*/5 * * * *",
          prompt: "给我讲一个笑话",
          enabled: true,
          lifecycleStatus: "active" as const,
          runCount: 0,
          recurring: true,
        },
      })),
      sessions: new Map([
        [
          "session-1",
          {
            app: {
              runtime: { getSessionModelSelection: () => undefined },
              getModel: () => undefined,
              getMode: () => undefined,
              getThoughtLevel: () => undefined,
              setCustomSessionTitle,
            },
            traceContext: { traceId: "trace-session-1" },
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext);

    await port.create(
      {
        cron: "*/5 * * * *",
        delayMinutes: null,
        prompt: "给我讲一个笑话",
        title: "每5分钟给我讲个笑话",
      },
      { sessionId: "session-1" },
    );

    expect(setCustomSessionTitle).toHaveBeenCalledWith({
      title: "每5分钟给我讲个笑话",
      traceContext: { traceId: "trace-session-1" },
    });
  });

  it("CronUpdate 将严格 patch 映射到 automation/update，并保留 maxRuns=null", async () => {
    const requestClient = vi.fn(async () => ({
      automation: {
        automationId: "automation-1",
        title: "updated report",
        cronExpr: "0 10 * * *",
        prompt: "write updated report",
        enabled: true,
        lifecycleStatus: "active" as const,
        runCount: 3,
        recurring: true,
      },
    }));
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    await expect(
      port.update({
        id: "automation-1",
        title: "updated report",
        cron: "0 10 * * *",
        recurring: true,
        maxRuns: null,
      }),
    ).resolves.toMatchObject({
      automationId: "automation-1",
      title: "updated report",
      runCount: 3,
    });
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationUpdate,
      {
        automationId: "automation-1",
        title: "updated report",
        cronExpr: "0 10 * * *",
        recurring: true,
        maxRuns: null,
      },
      expect.anything(),
    );
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.automationDelete,
      expect.anything(),
      expect.anything(),
    );
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      expect.anything(),
      expect.anything(),
    );
  });

  it("CronDelete 返回 protocol 的真实删除结果", async () => {
    const requestClient = vi.fn(async () => ({ deleted: false }));
    const port = createProtocolAutomationPort({
      requestClient,
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext);

    await expect(port.delete({ id: "stale-id" })).resolves.toBe(false);
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationDelete,
      { automationId: "stale-id" },
      expect.anything(),
    );
  });

  it("会话未登记在 context.sessions 时，仍从归属会话解析器读取权限/思考等级", async () => {
    // Bugfix 回归：V4/desktop 会话可能不在 legacy context.sessions map 里，activeSession 命中失败
    // 会导致 mode/thoughtLevel 丢失（model 靠 createContext 兜底才幸存）。改为绑定归属会话解析器。
    const setCustomSessionTitle = vi.fn(async () => undefined);
    const requestClient = vi.fn(async () => ({
      automation: {
        automationId: "automation-2",
        title: "daily report",
        cronExpr: "0 9 * * *",
        prompt: "write daily report",
        model: "zai-api/GLM-5",
        provider: "glm",
        mode: "plan" as const,
        thoughtLevel: "think-hard",
        enabled: true,
        lifecycleStatus: "active" as const,
        runCount: 0,
        recurring: true,
      },
    }));
    const ownSession = {
      app: {
        runtime: {
          getSessionModelSelection: () => ({
            providerId: "zai-api",
            modelId: "GLM-5",
            options: { reasoningLevel: "think-hard" },
          }),
        },
        getModel: () => "zai-api/GLM-5",
        getMode: () => "plan",
        getThoughtLevel: () => "think-hard",
        setCustomSessionTitle,
      },
      traceContext: { traceId: "trace-session-1" },
    };
    const port = createProtocolAutomationPort(
      {
        requestClient,
        // 归属会话故意不在 sessions map 中，模拟 V4/desktop 场景。
        sessions: new Map(),
      } as unknown as ZCodeProtocolAgentServerContext,
      () => ownSession as unknown as never,
    );

    await port.create(
      {
        cron: "0 9 * * *",
        delayMinutes: null,
        prompt: "write daily report",
        title: "daily report",
      },
      { model: "stale-provider/stale-model", sessionId: "session-1" },
    );

    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCreate,
      {
        cronExpr: "0 9 * * *",
        prompt: "write daily report",
        title: "daily report",
        recurring: true,
        modelSelection: {
          providerId: "zai-api",
          modelId: "GLM-5",
          options: { reasoningLevel: "think-hard" },
        },
        mode: "plan",
        targetTaskId: "session-1",
      },
      expect.anything(),
    );
  });
});
