// L2：v4 原生 switchModelConfig——验证自旧 server-operations.switchModelConfig 搬运的
// 决策语义在原生层保真：previous 在 setModel 之前从 getSessionModelSelection 快照、
// 跨模型由 setModel 解析目标兼容 thought、同模型显式 thought 才调 setThoughtLevel、
// session 不存在拒绝。08-phasing M4 完成定义的 L2 层。
// R-19（10 §4.2.3）追加：同值切换 → V4CommandNoopError(config.unchanged)；
// applyRequestedSessionConfig（createSession.config 消费共用件）。
import { describe, expect, it, vi } from "vitest";
import { parseCommandEnvelope, type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  V4CommandExecutor,
  V4SessionNotFoundError,
} from "../src/zcode-protocol-v4/commands/executor.js";
import { applyRequestedSessionConfig } from "../src/zcode-protocol-v4/commands/handlers/model-config.js";
import { V4CommandNoopError } from "../src/zcode-protocol-v4/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

/** 切换前的结构化选型。 */
const PREVIOUS_SELECTION = { providerId: "prov-a", modelId: "old-model" };
const TRACE = { traceId: "trace-1", sessionId: "s1" };
const SUPPORTED_THOUGHT_LEVELS = ["low", "medium", "high", "max"];

function makeApp() {
  // calls 记录跨方法调用顺序（顺序本身是搬运语义：先快照 previous，再切模型，最后补发事件）。
  const calls: string[] = [];
  return {
    calls,
    sessionId: "s1",
    runtime: {
      getPlanEnabled: vi.fn(() => false),
      setExecutionState: vi.fn(async () => {}),
      getSessionModelSelection: vi.fn(() => {
        calls.push("getSessionModelSelection");
        return PREVIOUS_SELECTION;
      }),
      emitModelSelected: vi.fn(async () => {
        calls.push("emitModelSelected");
      }),
      emitModeChanged: vi.fn(async () => {
        calls.push("emitModeChanged");
      }),
    },
    setModel: vi.fn(async () => {
      calls.push("setModel");
      return { thoughtLevel: undefined };
    }),
    setThoughtLevel: vi.fn(async (level: string) => {
      calls.push("setThoughtLevel");
      return { thoughtLevel: level };
    }),
    getThoughtLevel: vi.fn((): string | undefined => undefined),
    listThoughtLevels: vi.fn(() => ["low", "medium", "high", "max"]),
    getMode: vi.fn(() => {
      calls.push("getMode");
      return "build";
    }),
    setMode: vi.fn(async () => {
      calls.push("setMode");
      return {};
    }),
    setFollowupMode: vi.fn(async () => {
      calls.push("setFollowupMode");
    }),
  };
}

function makeRecord(app: ReturnType<typeof makeApp>): V4SessionRecordView {
  return {
    app: app as unknown as V4SessionRecordView["app"],
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    traceContext: TRACE,
  } as V4SessionRecordView;
}

function makeHost(record: V4SessionRecordView): V4CommandCoreHost {
  return {
    getRecord: (id) => (id === "s1" ? record : undefined),
  };
}

function envelope(sessionId: string, payload: unknown): CommandEnvelope {
  return {
    type: "switchModelConfig",
    payload,
    sessionId,
    commandId: "cmd-1",
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

describe("v4 原生 switchModelConfig", () => {
  it("跨模型且 payload thought 不受目标支持：setModel 解析目标实际 thought，不把源模型 thought 再次强写", async () => {
    const app = makeApp();
    app.setModel.mockImplementationOnce(async () => {
      app.calls.push("setModel");
      return { thoughtLevel: "high" };
    });
    const record = makeRecord(app);
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("s1", { provider: "prov-a", model: "new-model", thought: "enabled" }),
    );
    // 顺序：Selection 必须在 setModel 之前快照，否则 previous 会在切换后丢失。
    expect(app.calls).toEqual(["getSessionModelSelection", "setModel", "emitModelSelected"]);
    // setModel 仍接收协议边界的 "providerId/modelId" 文本选择。
    expect(app.setModel).toHaveBeenCalledWith("prov-a/new-model");
    expect(app.setThoughtLevel).not.toHaveBeenCalled();
    // payload.enabled 是源模型附带值；effective 档位单独投影，稀疏 Selection 不 pin 默认值。
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith({
      modelSelection: { providerId: "prov-a", modelId: "new-model" },
      effectiveReasoningLevel: "high",
      previousModelSelection: PREVIOUS_SELECTION,
      supportedThoughtLevels: SUPPORTED_THOUGHT_LEVELS,
      traceContext: TRACE,
    });
  });

  it("跨 provider 且源 thought 不兼容：模型切换成功，默认档位不反写 Selection", async () => {
    const app = makeApp();
    app.setModel.mockImplementationOnce(async () => {
      app.calls.push("setModel");
      return { thoughtLevel: "max" };
    });
    const record = makeRecord(app);
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("s1", {
        provider: "default-deepseek",
        model: "deepseek-v4-flash",
        thought: "enabled",
      }),
    );
    expect(app.setModel).toHaveBeenCalledWith("default-deepseek/deepseek-v4-flash");
    expect(app.setThoughtLevel).not.toHaveBeenCalled();
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith({
      modelSelection: {
        providerId: "default-deepseek",
        modelId: "deepseek-v4-flash",
      },
      effectiveReasoningLevel: "max",
      previousModelSelection: PREVIOUS_SELECTION,
      supportedThoughtLevels: SUPPORTED_THOUGHT_LEVELS,
      traceContext: TRACE,
    });
  });

  it("跨模型且目标支持 payload thought：切模型后显式收敛到用户选择的 thought", async () => {
    const app = makeApp();
    app.setModel.mockImplementationOnce(async () => {
      app.calls.push("setModel");
      return { thoughtLevel: "medium" };
    });
    const record = makeRecord(app);
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("s1", { provider: "prov-a", model: "new-model", thought: "high" }),
    );
    expect(app.calls).toEqual([
      "getSessionModelSelection",
      "setModel",
      "setThoughtLevel",
      "emitModelSelected",
    ]);
    expect(app.setModel).toHaveBeenCalledWith("prov-a/new-model");
    expect(app.setThoughtLevel).toHaveBeenCalledWith("high");
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith({
      modelSelection: {
        providerId: "prov-a",
        modelId: "new-model",
        options: { reasoningLevel: "high" },
      },
      effectiveReasoningLevel: "high",
      previousModelSelection: PREVIOUS_SELECTION,
      supportedThoughtLevels: SUPPORTED_THOUGHT_LEVELS,
      traceContext: TRACE,
    });
  });

  it("同模型显式切 thought：只调 setThoughtLevel，再发布实际档位", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("s1", { provider: "prov-a", model: "old-model", thought: "max" }),
    );
    expect(app.setModel).not.toHaveBeenCalled();
    expect(app.setThoughtLevel).toHaveBeenCalledWith("max");
    expect(app.calls).toEqual(["getSessionModelSelection", "setThoughtLevel", "emitModelSelected"]);
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith({
      modelSelection: {
        providerId: "prov-a",
        modelId: "old-model",
        options: { reasoningLevel: "max" },
      },
      effectiveReasoningLevel: "max",
      previousModelSelection: PREVIOUS_SELECTION,
      supportedThoughtLevels: SUPPORTED_THOUGHT_LEVELS,
      traceContext: TRACE,
    });
  });

  it("同模型显式选择 effective 默认档位仍保存为稀疏 Selection pin", async () => {
    const app = makeApp();
    app.getThoughtLevel.mockReturnValue("high");
    const record = makeRecord(app);

    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("s1", { provider: "prov-a", model: "old-model", thought: "high" }),
    );

    expect(app.setThoughtLevel).toHaveBeenCalledWith("high");
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          providerId: "prov-a",
          modelId: "old-model",
          options: { reasoningLevel: "high" },
        },
        effectiveReasoningLevel: "high",
      }),
    );
  });

  it("同模型显式切到不支持的 thought：失败且不触碰模型身份", async () => {
    const app = makeApp();
    app.setThoughtLevel.mockRejectedValueOnce(new Error("Unsupported reasoning effort: enabled"));
    const record = makeRecord(app);
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("s1", { provider: "prov-a", model: "old-model", thought: "enabled" }),
      ),
    ).rejects.toThrow("Unsupported reasoning effort: enabled");
    expect(app.setModel).not.toHaveBeenCalled();
    expect(app.runtime.emitModelSelected).not.toHaveBeenCalled();
  });

  it("thought 缺省（空串）：不调 setThoughtLevel，selection 不带 reasoning option", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("s1", { provider: "prov-a", model: "new-model", thought: "" }),
    );
    expect(app.setThoughtLevel).not.toHaveBeenCalled();
    expect(app.calls).toEqual(["getSessionModelSelection", "setModel", "emitModelSelected"]);
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith({
      modelSelection: { providerId: "prov-a", modelId: "new-model" },
      previousModelSelection: PREVIOUS_SELECTION,
      supportedThoughtLevels: SUPPORTED_THOUGHT_LEVELS,
      traceContext: TRACE,
    });
  });

  it("session 不存在：拒绝且不触碰任何 core 方法", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("missing", { provider: "p", model: "m", thought: "" }),
      ),
    ).rejects.toThrow(V4SessionNotFoundError);
    expect(app.setModel).not.toHaveBeenCalled();
    expect(app.runtime.emitModelSelected).not.toHaveBeenCalled();
  });

  // R-19：同值切换不得以 accepted 静默吞掉——UI 需要区分「已生效」与「本来就是这个值」。
  it("同值切换：抛 V4CommandNoopError(config.unchanged)，不切模型不补发事件", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("s1", { provider: "prov-a", model: "old-model", thought: "" }),
      ),
    ).rejects.toThrow(V4CommandNoopError);
    expect(app.setModel).not.toHaveBeenCalled();
    expect(app.setThoughtLevel).not.toHaveBeenCalled();
    expect(app.runtime.emitModelSelected).not.toHaveBeenCalled();
  });

  it("同模型显式选择 effective 值：仍固定为 option pin", async () => {
    const app = makeApp();
    app.getThoughtLevel.mockReturnValue("max");
    const record = makeRecord(app);
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("s1", { provider: "prov-a", model: "old-model", thought: "max" }),
    );
    expect(app.setModel).not.toHaveBeenCalled();
    expect(app.setThoughtLevel).toHaveBeenCalledWith("max");
  });

  it("supports 分流：switchModelConfig 已原生", () => {
    const executor = new V4CommandExecutor(makeHost(makeRecord(makeApp())));
    expect(executor.supports("switchModelConfig")).toBe(true);
  });
});

// M5 additive：switchCollaborationMode（UI 模式选择器 → app.setMode + SessionModeChanged 补发）。
describe("v4 原生 switchCollaborationMode", () => {
  it("guarded 经同一模式命令切换，未知值报错而不降级", async () => {
    const app = makeApp();
    const executor = new V4CommandExecutor(makeHost(makeRecord(app)));
    const requested = {
      ...modeEnvelope("s1", { mode: "guarded" }),
      clientId: "test",
      issuedAt: Date.now(),
    };
    const parsed = parseCommandEnvelope(requested);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    await executor.execute(parsed.envelope);
    expect(app.setMode).toHaveBeenCalledWith("guarded");
    // executor 只消费协议边界已经校验的 envelope，未知模式应在同一边界被拒绝。
    expect(parseCommandEnvelope({ ...requested, payload: { mode: "unsupported" } }).ok).toBe(false);
    expect(app.setMode).toHaveBeenCalledTimes(1);
  });
  function modeEnvelope(sessionId: string, payload: unknown): CommandEnvelope {
    return {
      type: "switchCollaborationMode",
      payload,
      sessionId,
      commandId: "cmd-mode-1",
      baseRevision: 0,
    } as unknown as CommandEnvelope;
  }

  it("正路径：setMode 内部统一更新状态和事件，命令层不重复补发", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await new V4CommandExecutor(makeHost(record)).execute(modeEnvelope("s1", { mode: "plan" }));
    expect(app.calls).toEqual(["getMode", "setMode"]);
    expect(app.setMode).toHaveBeenCalledWith("plan");
    expect(app.runtime.emitModeChanged).not.toHaveBeenCalled();
  });

  // R-19：同值切换从静默 return（被当 accepted）改为显式 noop——旧行为与投影种子缺失
  // 叠加成过「点完全访问没反应」的用户可见 bug（runtime 已是 yolo、投影种子还是 build）。
  it("同值切换：抛 V4CommandNoopError(config.unchanged)——不调 setMode、不补发事件（不 bump revision）", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(modeEnvelope("s1", { mode: "build" })),
    ).rejects.toThrow(V4CommandNoopError);
    expect(app.setMode).not.toHaveBeenCalled();
    expect(app.runtime.emitModeChanged).not.toHaveBeenCalled();
  });

  it("session 不存在：拒绝且不触碰任何 core 方法", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(modeEnvelope("missing", { mode: "plan" })),
    ).rejects.toThrow(V4SessionNotFoundError);
    expect(app.setMode).not.toHaveBeenCalled();
  });

  it("supports 分流：switchCollaborationMode 已原生", () => {
    const executor = new V4CommandExecutor(makeHost(makeRecord(makeApp())));
    expect(executor.supports("switchCollaborationMode")).toBe(true);
  });
});

// R-19：createSession.config 消费共用件——请求 config 覆盖 runtime 缺省，
// 只对差异部分生效并补发与 switch 命令同源的事件（日志自足）。
describe("切模型前校验当前 Environment Provider", () => {
  function makeResolvingHost(
    record: V4SessionRecordView,
    outcome: { available: boolean; reason?: string },
    captured: string[],
  ): V4CommandCoreHost {
    return {
      getRecord: (id) => (id === "s1" ? record : undefined),
      ensureProviderAvailable: async (_sessionId, providerId) => {
        captured.push(providerId);
        return outcome;
      },
    };
  }

  it("provider 已在 registry：setModel 之前解析放行，跨 provider 切换生效", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    const captured: string[] = [];
    await new V4CommandExecutor(makeResolvingHost(record, { available: true }, captured)).execute(
      envelope("s1", { provider: "prov-b", model: "new-model", thought: "" }),
    );
    expect(captured).toEqual(["prov-b"]);
    expect(app.setModel).toHaveBeenCalledWith("prov-b/new-model");
    expect(app.runtime.emitModelSelected).toHaveBeenCalled();
  });

  it("provider 不在 registry（applied:false）：failed reasonCode=provider.notInRegistry，不切模型/不补发", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    const captured: string[] = [];
    await expect(
      new V4CommandExecutor(
        makeResolvingHost(
          record,
          { available: false, reason: "provider_not_in_registry" },
          captured,
        ),
      ).execute(envelope("s1", { provider: "prov-x", model: "m", thought: "" })),
    ).rejects.toMatchObject({ reasonCode: "provider.notInRegistry" });
    expect(app.setModel).not.toHaveBeenCalled();
    expect(app.runtime.emitModelSelected).not.toHaveBeenCalled();
  });

  it("普通模型切换不把 Host runtimeModel 交给 Provider 就绪检查", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    const captured: string[] = [];
    const runtimeModel = {
      revision: "model-runtime:1",
      generatedAt: 1,
      model: { providerId: "prov-b", modelId: "new-model" },
      provider: {
        providerId: "prov-b",
        kind: "openai-chat",
        models: [{ modelId: "new-model" }],
      },
    };
    await new V4CommandExecutor(makeResolvingHost(record, { available: true }, captured)).execute(
      envelope("s1", {
        provider: "prov-b",
        model: "new-model",
        thought: "",
        runtimeModel,
      }),
    );
    expect(captured).toEqual(["prov-b"]);
    expect(app.setModel).toHaveBeenCalledWith("prov-b/new-model");
  });

  it("host 无 ensureProviderAvailable（旧 binder/夹具）：跳过能力，同 provider 直切不回归", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("s1", { provider: "prov-a", model: "new-model", thought: "" }),
    );
    expect(app.setModel).toHaveBeenCalledWith("prov-a/new-model");
    expect(app.runtime.emitModelSelected).toHaveBeenCalled();
  });
});

describe("applyRequestedSessionConfig（createSession.config 消费）", () => {
  it("模型差异：setModel → setThoughtLevel → emitModelSelected（previous 保真）", async () => {
    const app = makeApp();
    app.setModel.mockImplementationOnce(async () => {
      app.calls.push("setModel");
      return { thoughtLevel: "medium" };
    });
    const record = makeRecord(app);
    await applyRequestedSessionConfig(makeHost(record), record, {
      provider: "prov-b",
      model: "new-model",
      thought: "high",
    });
    expect(app.setModel).toHaveBeenCalledWith("prov-b/new-model");
    expect(app.setThoughtLevel).toHaveBeenCalledWith("high");
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith({
      modelSelection: {
        providerId: "prov-b",
        modelId: "new-model",
        options: { reasoningLevel: "high" },
      },
      effectiveReasoningLevel: "high",
      previousModelSelection: PREVIOUS_SELECTION,
      supportedThoughtLevels: SUPPORTED_THOUGHT_LEVELS,
      traceContext: TRACE,
    });
  });

  it("模型差异且 thought 不受目标支持：保留 setModel 实际档位并照常发布目标模型", async () => {
    const app = makeApp();
    app.setModel.mockImplementationOnce(async () => {
      app.calls.push("setModel");
      return { thoughtLevel: "max" };
    });
    const record = makeRecord(app);
    await applyRequestedSessionConfig(makeHost(record), record, {
      provider: "default-deepseek",
      model: "deepseek-v4-flash",
      thought: "enabled",
    });
    expect(app.setThoughtLevel).not.toHaveBeenCalled();
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith({
      modelSelection: {
        providerId: "default-deepseek",
        modelId: "deepseek-v4-flash",
      },
      effectiveReasoningLevel: "max",
      previousModelSelection: PREVIOUS_SELECTION,
      supportedThoughtLevels: SUPPORTED_THOUGHT_LEVELS,
      traceContext: TRACE,
    });
  });

  it("部分字段（只给 thought）：provider/model 回落 runtime 当前值", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await applyRequestedSessionConfig(makeHost(record), record, { thought: "max" });
    expect(app.setModel).not.toHaveBeenCalled();
    expect(app.setThoughtLevel).toHaveBeenCalledWith("max");
    expect(app.runtime.emitModelSelected).toHaveBeenCalledWith({
      modelSelection: {
        providerId: "prov-a",
        modelId: "old-model",
        options: { reasoningLevel: "max" },
      },
      effectiveReasoningLevel: "max",
      previousModelSelection: PREVIOUS_SELECTION,
      supportedThoughtLevels: SUPPORTED_THOUGHT_LEVELS,
      traceContext: TRACE,
    });
  });

  it("与 runtime 全同值：零调用零事件（不产空转 delta）", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await applyRequestedSessionConfig(makeHost(record), record, {
      provider: "prov-a",
      model: "old-model",
      thought: "",
      mode: "build",
      followupMode: "queue",
    });
    expect(app.setModel).not.toHaveBeenCalled();
    expect(app.setMode).not.toHaveBeenCalled();
    expect(app.setFollowupMode).not.toHaveBeenCalled();
    expect(app.runtime.emitModelSelected).not.toHaveBeenCalled();
    expect(app.runtime.emitModeChanged).not.toHaveBeenCalled();
  });

  it("mode 差异由 Runtime 原子更新；非法 mode 值被值域收口忽略", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await applyRequestedSessionConfig(makeHost(record), record, { mode: "yolo" });
    expect(app.runtime.setExecutionState).toHaveBeenCalledWith({ mode: "yolo" }, TRACE);
    expect(app.runtime.emitModeChanged).not.toHaveBeenCalled();

    const app2 = makeApp();
    const record2 = makeRecord(app2);
    await applyRequestedSessionConfig(makeHost(record2), record2, { mode: "auto" });
    expect(app2.setMode).not.toHaveBeenCalled();
    expect(app2.runtime.emitModeChanged).not.toHaveBeenCalled();
  });

  it("followupMode=guide 显式写；queue（缺省同值）跳过避免空转事件", async () => {
    const app = makeApp();
    const record = makeRecord(app);
    await applyRequestedSessionConfig(makeHost(record), record, { followupMode: "guide" });
    expect(app.setFollowupMode).toHaveBeenCalledWith("guide");
  });
});
