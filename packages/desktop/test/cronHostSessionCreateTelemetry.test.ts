import { readFile } from "node:fs/promises";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

let createDispatch: (
  deps: Record<string, unknown>,
) => (request: Record<string, unknown>) => Promise<unknown>;
beforeAll(async () => {
  // 装载生产函数，隔离 host 启动副作用；不复制派发实现。
  const path = new URL("../src/host/index.ts", import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "dispatchCronRun",
  );
  if (!fn) throw new Error("dispatchCronRun missing");
  const code = ts.transpileModule(fn.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  createDispatch = (deps) =>
    new Function(...Object.keys(deps), `${code}; return dispatchCronRun;`)(...Object.values(deps));
});
function setup() {
  const service = {
    createTask: vi.fn(async () => ({ taskId: "new-session" })),
    resumeTask: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
  };
  const report = vi.fn();
  const taskKey = Symbol(),
    modelKey = Symbol(),
    botsKey = Symbol();
  const selection = { providerId: "test", modelId: "test" };
  const dispatch = createDispatch({
    IZCodeTaskService: taskKey,
    IModelSelectionService: modelKey,
    IBotsService: botsKey,
    resolveAutomationTargetServices: () => ({
      getOptional: (key: symbol) => (key === taskKey ? service : key === modelKey ? {} : undefined),
    }),
    cronAutomationRepo: { getRun: async () => null, fixRunModelSelection: async () => selection },
    resolveAutomationSubmissionModelSelection: async () => selection,
    resolveWorkspaceKey: () => "workspace",
    formatModelPickerValue: () => "test/test",
    parseCronRunScheduledAt: () => 1,
    applyCronRunConfigToExistingTask: async () => {},
    cronRunSubscriptionKey: () => "key",
    trackCronRunOutcome: vi.fn(),
    disposeCronRunSubscription: vi.fn(),
    markCronRunOutcome: vi.fn(),
    reportHostSessionCreate: report,
    parentPort: {},
  });
  const request = {
    automationId: "a1",
    runId: "a1:1000",
    workspacePath: "/private",
    workspaceIdentity: "remote:ssh:host:/private",
    prompt: "prompt",
  };
  return { service, report, dispatch, request };
}
describe("定时任务的 Session 创建口径", () => {
  it.each(["a1:1000", "a1:manual:1000"])("新建会话 %s 首发 accepted 后才报告", async (runId) => {
    const state = setup();
    let accept!: () => void;
    state.service.sendPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const dispatched = state.dispatch({ ...state.request, runId });
    await vi.waitFor(() => expect(state.service.sendPrompt).toHaveBeenCalledOnce());
    expect(state.report).not.toHaveBeenCalled();
    accept();
    await dispatched;
    expect(state.report).toHaveBeenCalledExactlyOnceWith(
      {},
      {
        sessionId: "new-session",
        messageId: runId,
        source: "automation_scheduled",
        workspaceIdentity: state.request.workspaceIdentity,
      },
    );
  });
  it("prompt 创建的任务绑定原会话，多次追加都不报告", async () => {
    const state = setup();
    await state.dispatch({ ...state.request, targetTaskId: "existing" });
    await state.dispatch({ ...state.request, runId: "a1:2000", targetTaskId: "existing" });
    expect(state.service.createTask).not.toHaveBeenCalled();
    expect(state.service.resumeTask).toHaveBeenCalledTimes(2);
    expect(state.service.sendPrompt).toHaveBeenCalledTimes(2);
    expect(state.report).not.toHaveBeenCalled();
  });
  it("新建后首发拒绝不报告", async () => {
    const state = setup();
    state.service.sendPrompt.mockRejectedValue(new Error("rejected"));
    await expect(state.dispatch(state.request)).rejects.toThrow("rejected");
    expect(state.report).not.toHaveBeenCalled();
  });
});
