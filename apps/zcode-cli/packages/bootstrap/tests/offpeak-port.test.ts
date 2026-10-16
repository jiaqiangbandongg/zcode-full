import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";
import {
  createProtocolOffPeakPort,
  OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR,
  OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR,
  OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR,
} from "../src/zcode-protocol/offpeak-port.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createSessionRecordForV4, closeSession } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeAppOptions } from "../src/app/types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

it.each([
  { enabled: true, preference: false, expected: true },
  { enabled: false, preference: true, expected: true },
  { enabled: false, preference: false, expected: false },
])("协议工厂保留闲时能力装配门禁：%j", async ({ enabled, preference, expected }) => {
  let appOptions: ZCodeAppOptions | undefined;
  const server = new ZCodeProtocolAgentServer({
    createZCodeApp: (options) => {
      appOptions = options;
      return createFakeApp(options);
    },
  });
  const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
  context.appRuntimePreferences.offPeakToolEnabled = preference;
  const result = await createSessionRecordForV4(context, {
    workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    offPeakToolEnabled: enabled,
  });
  try {
    expect(Boolean(appOptions?.offPeakPort)).toBe(expected);
    if (expected) {
      const requestClient = vi.spyOn(context, "requestClient").mockResolvedValue({ tasks: [] });
      await expect(appOptions!.offPeakPort!.list({ sessionId: result.sessionId })).resolves.toEqual(
        [],
      );
      expect(requestClient).toHaveBeenCalledWith(
        zcodeProtocolMethods.offPeakList,
        {},
        expect.anything(),
      );
    }
  } finally {
    await closeSession(context, { sessionId: result.sessionId });
  }
});

const protocolTask = {
  offPeakTaskId: "offpeak-1",
  title: "重构 utils",
  status: "queued" as const,
  queuePosition: 3,
  createdAt: 1_700_000_000_000,
};

function contextOf(params: {
  requestClient: ReturnType<typeof vi.fn>;
  session?: Record<string, unknown>;
}): ZCodeProtocolAgentServerContext {
  return {
    requestClient: params.requestClient,
    sessions: new Map(params.session ? [["session-1", params.session]] : []),
  } as unknown as ZCodeProtocolAgentServerContext;
}

/** 绑定守卫先走 offPeak/list；缺省返回空列表，让 create 路径直通。 */
function requestClientWith(
  handlers: Partial<Record<string, (params: unknown) => unknown>>,
  listed: Array<Record<string, unknown>> = [],
) {
  return vi.fn(async (method: string, params?: unknown) => {
    if (method === zcodeProtocolMethods.offPeakList) return { tasks: listed };
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected method ${method}`);
    return handler(params);
  });
}

describe("createProtocolOffPeakPort", () => {
  it("拒绝闲时派发 turn 里再次 OffPeakCreate（D49-2），且不调用 offPeak/create", async () => {
    const requestClient = vi.fn();
    const port = createProtocolOffPeakPort(
      contextOf({
        requestClient,
        session: { activeOffPeakTaskId: "offpeak-parent", app: {} },
      }),
    );

    await expect(
      port.create({ title: "nested", prompt: "nested" }, { sessionId: "session-1" }),
    ).rejects.toThrow(OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR);
    expect(requestClient).not.toHaveBeenCalled();
  });

  it("automation 执行 turn 放行 OffPeakCreate（D49-3：不查 activeAutomationId、不查 cron 绑定）", async () => {
    const requestClient = requestClientWith({
      [zcodeProtocolMethods.offPeakCreate]: () => ({ ok: true, task: protocolTask }),
    });
    const port = createProtocolOffPeakPort(
      contextOf({
        requestClient,
        session: { activeAutomationId: "automation-parent", app: {} },
      }),
    );

    await expect(
      port.create({ title: "定时派生", prompt: "nightly digest" }, { sessionId: "session-1" }),
    ).resolves.toEqual({ ok: true, task: protocolTask });
    // 与 automation-port 相反：不查 cron 绑定（cron 轮派生闲时任务是 D49-3 组合玩法），
    // 放大防护的唯一权威是服务端取号额度。
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.automationCheckTaskBinding,
      expect.anything(),
      expect.anything(),
    );
  });

  it("create 透传显式入参 + 绑定当前会话（D50），不注入会话运行态，也不冻结会话标题（D49-4/5）", async () => {
    const setCustomSessionTitle = vi.fn(async () => undefined);
    const requestClient = requestClientWith({
      [zcodeProtocolMethods.offPeakCreate]: () => ({ ok: true, task: protocolTask }),
    });
    const port = createProtocolOffPeakPort(
      contextOf({
        requestClient,
        session: {
          app: {
            getModel: () => "builtin:zai/GLM-5",
            getMode: () => "yolo",
            getThoughtLevel: () => "nothink",
            setCustomSessionTitle,
          },
          traceContext: { traceId: "trace-1" },
        },
      }),
    );

    await port.create({ title: "重构 utils", prompt: "do it" }, { sessionId: "session-1" });
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.offPeakCreate,
      { title: "重构 utils", prompt: "do it", boundSessionId: "session-1" },
      expect.anything(),
    );
    expect(setCustomSessionTitle).not.toHaveBeenCalled();
  });

  it("本会话已绑定未终态闲时任务时拒绝再建，且不调用 offPeak/create（D50）", async () => {
    const requestClient = requestClientWith(
      { [zcodeProtocolMethods.offPeakCreate]: () => ({ ok: true, task: protocolTask }) },
      [{ ...protocolTask, status: "running", sessionId: "session-1" }],
    );
    const port = createProtocolOffPeakPort(contextOf({ requestClient, session: { app: {} } }));

    await expect(
      port.create({ title: "again", prompt: "again" }, { sessionId: "session-1" }),
    ).rejects.toThrow(OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR);
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.offPeakCreate,
      expect.anything(),
      expect.anything(),
    );
  });

  it("绑定任务已终态或属于其他会话时放行（D50：一次性任务，跑完可再建）", async () => {
    const requestClient = requestClientWith(
      { [zcodeProtocolMethods.offPeakCreate]: () => ({ ok: true, task: protocolTask }) },
      [
        {
          ...protocolTask,
          offPeakTaskId: "offpeak-done",
          status: "completed",
          sessionId: "session-1",
        },
        {
          ...protocolTask,
          offPeakTaskId: "offpeak-other",
          status: "queued",
          sessionId: "session-2",
        },
      ],
    );
    const port = createProtocolOffPeakPort(contextOf({ requestClient, session: { app: {} } }));

    await expect(
      port.create({ title: "again", prompt: "again" }, { sessionId: "session-1" }),
    ).resolves.toEqual({ ok: true, task: protocolTask });
  });

  it("绑定查询失败 fail-closed，不放行创建", async () => {
    const requestClient = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.offPeakList) throw new Error("db locked");
      return { ok: true, task: protocolTask };
    });
    const port = createProtocolOffPeakPort(contextOf({ requestClient, session: { app: {} } }));

    await expect(
      port.create({ title: "t", prompt: "p" }, { sessionId: "session-1" }),
    ).rejects.toThrow(OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR);
    expect(requestClient).not.toHaveBeenCalledWith(
      zcodeProtocolMethods.offPeakCreate,
      expect.anything(),
      expect.anything(),
    );
  });

  it("ok:false 判别联合原样透传分类，不降级为异常", async () => {
    const failure = {
      ok: false,
      failureStage: "ticket_request",
      errorCategory: "quota_3103",
      errorCode: "3103",
    };
    const requestClient = requestClientWith({
      [zcodeProtocolMethods.offPeakCreate]: () => failure,
    });
    const port = createProtocolOffPeakPort(contextOf({ requestClient }));

    await expect(port.create({ title: "t", prompt: "p" })).resolves.toEqual(failure);
  });

  it("list 直通 offPeak/list 并映射最小快照", async () => {
    const requestClient = vi.fn(async () => ({ tasks: [protocolTask] }));
    const port = createProtocolOffPeakPort(contextOf({ requestClient }));

    await expect(port.list()).resolves.toEqual([
      {
        offPeakTaskId: "offpeak-1",
        title: "重构 utils",
        status: "queued",
        queuePosition: 3,
        sessionId: undefined,
        createdAt: 1_700_000_000_000,
      },
    ]);
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.offPeakList,
      {},
      expect.anything(),
    );
  });
});
