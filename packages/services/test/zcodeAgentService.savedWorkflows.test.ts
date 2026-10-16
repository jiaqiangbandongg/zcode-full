// 已保存工作流五个 v3 方法（docs/dynamic-workflow/launch.md「Data path」）：经 read-only client 调对应方法名与 params 形状。
// 全局作用域与 move（docs/dynamic-workflow/launch.md「Data path」）：scope 下推、载体运行时选择、workflows/move。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";

async function createServiceWithRequest(request: ReturnType<typeof vi.fn>) {
  const getClient = vi.fn(async () => ({
    request,
    transportKind: "stdio" as const,
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
  }));
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      getClient = getClient;
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      disposeAll() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  return { service: createZCodeAgentService(), getClient };
}

const WORKSPACE = expect.objectContaining({ workspacePath: "/repo" });

describe("ZCodeAgentService saved workflows", () => {
  it("listSavedWorkflows → workflows/list，只带 workspace", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsList) return { workflows: [], invalid: [] };
      throw new Error(`Unexpected method ${method}`);
    });
    const { service, getClient } = await createServiceWithRequest(request);
    await expect(service.listSavedWorkflows({ workspacePath: "/repo" })).resolves.toEqual({
      workflows: [],
      invalid: [],
    });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workflowsList,
      { workspace: WORKSPACE },
      expect.anything(),
    );
    service.disposeAll();
  });

  it("getSavedWorkflow / deleteSavedWorkflow → 对应方法 + name", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsGet) {
        return {
          ok: true,
          name: "x",
          path: "/repo/.zcode/workflows/x.dwf.ts",
          scope: "project",
          meta: { description: "d" },
          script: "export default async () => {}",
        };
      }
      if (method === zcodeProtocolMethods.workflowsDelete)
        return { ok: false, reason: "not_found" };
      throw new Error(`Unexpected method ${method}`);
    });
    const { service } = await createServiceWithRequest(request);
    const detail = await service.getSavedWorkflow({ workspacePath: "/repo", name: "x" });
    expect(detail).toMatchObject({ ok: true, name: "x", script: "export default async () => {}" });
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workflowsGet,
      { workspace: WORKSPACE, name: "x" },
      expect.anything(),
    );
    await expect(
      service.deleteSavedWorkflow({ workspacePath: "/repo", name: "gone" }),
    ).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workflowsDelete,
      { workspace: WORKSPACE, name: "gone" },
      expect.anything(),
    );
    service.disposeAll();
  });

  it("updateSavedWorkflowMeta → workflows/updateMeta，meta 原样透传", async () => {
    const meta = {
      description: "新说明",
      whenToUse: "发布前",
      args: { branch: { type: "string" as const } },
    };
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsUpdateMeta) {
        return { ok: true, path: "/repo/.zcode/workflows/x.dwf.ts" };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { service } = await createServiceWithRequest(request);
    await expect(
      service.updateSavedWorkflowMeta({ workspacePath: "/repo", name: "x", meta }),
    ).resolves.toEqual({ ok: true, path: "/repo/.zcode/workflows/x.dwf.ts" });
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workflowsUpdateMeta,
      { workspace: WORKSPACE, name: "x", meta },
      expect.anything(),
    );
    service.disposeAll();
  });

  it("listSavedWorkflowRuns → workflows/runs，name 可选、limit 必传", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsRuns) {
        return {
          runs: [
            {
              runId: "r1",
              name: "x",
              status: "completed",
              createdAt: 1,
              updatedAt: 2,
              spentTokens: 3,
              parentSessionId: "s1",
              toolCallId: "t1",
              args: { branch: "main" },
            },
          ],
          truncated: true,
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { service } = await createServiceWithRequest(request);
    const result = await service.listSavedWorkflowRuns({ workspacePath: "/repo", limit: 20 });
    expect(result.runs).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsRuns,
      { workspace: WORKSPACE, limit: 20 },
      expect.anything(),
    );
    await service.listSavedWorkflowRuns({ workspacePath: "/repo", name: "x", limit: 5 });
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsRuns,
      { workspace: WORKSPACE, name: "x", limit: 5 },
      expect.anything(),
    );
    service.disposeAll();
  });
});

// 各方法的 schema 校验发生在真实 client；这里 request 是 stub，只回够断言的形状即可。
function replyForMethod(method: string): unknown {
  switch (method) {
    case zcodeProtocolMethods.workflowsList:
      return { workflows: [], invalid: [], dir: "/repo/.zcode/workflows" };
    case zcodeProtocolMethods.workflowsGet:
      return {
        ok: true,
        name: "x",
        path: "/repo/.zcode/workflows/x.dwf.ts",
        scope: "global",
        meta: { description: "d" },
        script: "export default async () => {}",
      };
    case zcodeProtocolMethods.workflowsUpdateMeta:
      return { ok: true, path: "/repo/.zcode/workflows/x.dwf.ts" };
    case zcodeProtocolMethods.workflowsDelete:
      return { ok: true, path: "/repo/.zcode/workflows/x.dwf.ts" };
    case zcodeProtocolMethods.workflowsRuns:
      return { runs: [], truncated: false };
    case zcodeProtocolMethods.workflowsMove:
      return { ok: true, from: "/from.dwf.ts", to: "/to.dwf.ts", scope: "global" };
    default:
      throw new Error(`Unexpected method ${method}`);
  }
}

describe("ZCodeAgentService saved workflows scope 下推", () => {
  it("五个方法在 scope 有定义时把它写进 RPC params（全局档带 workspace 直通）", async () => {
    const request = vi.fn(async (method: string) => replyForMethod(method));
    const { service } = await createServiceWithRequest(request);
    const base = { workspacePath: "/repo", scope: "global" as const };

    await service.listSavedWorkflows(base);
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsList,
      { workspace: WORKSPACE, scope: "global" },
      expect.anything(),
    );

    await service.getSavedWorkflow({ ...base, name: "x" });
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsGet,
      { workspace: WORKSPACE, name: "x", scope: "global" },
      expect.anything(),
    );

    const meta = { description: "d" };
    await service.updateSavedWorkflowMeta({ ...base, name: "x", meta });
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsUpdateMeta,
      { workspace: WORKSPACE, name: "x", meta, scope: "global" },
      expect.anything(),
    );

    await service.deleteSavedWorkflow({ ...base, name: "x" });
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsDelete,
      { workspace: WORKSPACE, name: "x", scope: "global" },
      expect.anything(),
    );

    await service.listSavedWorkflowRuns({ ...base, name: "x", limit: 20 });
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsRuns,
      { workspace: WORKSPACE, name: "x", limit: 20, scope: "global" },
      expect.anything(),
    );
    service.disposeAll();
  });

  it("不给 scope 时 RPC params 不含 scope 键（线上形状与今天逐字一致）", async () => {
    const request = vi.fn(async (method: string) => replyForMethod(method));
    const { service } = await createServiceWithRequest(request);
    await service.listSavedWorkflows({ workspacePath: "/repo" });
    const lastParams = request.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(lastParams).not.toHaveProperty("scope");
    expect(lastParams).toEqual({ workspace: WORKSPACE });
    service.disposeAll();
  });
});

describe("ZCodeAgentService moveSavedWorkflow", () => {
  // 只有全局→项目一向（docs/dynamic-workflow/launch.md「Promote to global」），请求体没有 to。
  it("→ workflows/move，带 workspace / name（无 to），解析 ok 分支", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsMove) {
        return {
          ok: true,
          from: "/home/.zcode/workflows/x.dwf.ts",
          to: "/repo/.zcode/workflows/x.dwf.ts",
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { service } = await createServiceWithRequest(request);
    await expect(service.moveSavedWorkflow({ workspacePath: "/repo", name: "x" })).resolves.toEqual(
      {
        ok: true,
        from: "/home/.zcode/workflows/x.dwf.ts",
        to: "/repo/.zcode/workflows/x.dwf.ts",
      },
    );
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workflowsMove,
      { workspace: WORKSPACE, name: "x" },
      expect.anything(),
    );
    service.disposeAll();
  });

  it("解析失败分支（target_exists）", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsMove) {
        return { ok: false, reason: "target_exists", path: "/repo/.zcode/workflows/x.dwf.ts" };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { service } = await createServiceWithRequest(request);
    await expect(service.moveSavedWorkflow({ workspacePath: "/repo", name: "x" })).resolves.toEqual(
      {
        ok: false,
        reason: "target_exists",
        path: "/repo/.zcode/workflows/x.dwf.ts",
      },
    );
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsMove,
      { workspace: WORKSPACE, name: "x" },
      expect.anything(),
    );
    service.disposeAll();
  });
});

describe("ZCodeAgentService 全局档载体运行时选择（无 workspace）", () => {
  const originalDataDir = process.env.ZCODE_DATA_BASE_DIR;
  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.ZCODE_DATA_BASE_DIR;
    } else {
      process.env.ZCODE_DATA_BASE_DIR = originalDataDir;
    }
  });

  it("(a) 复用任一已活跃的本地 runtime 当载体（不新拉进程）", async () => {
    const request = vi.fn(async (method: string) => replyForMethod(method));
    const { service, getClient } = await createServiceWithRequest(request);
    // 先让 /repo 有一个活跃的本地 runtime。
    await service.listSavedWorkflows({ workspacePath: "/repo" });
    expect(getClient).toHaveBeenCalledTimes(1);
    // 全局档不带 workspace：复用 /repo 的 client，不再 getClient。
    await service.listSavedWorkflows({ scope: "global" });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsList,
      { workspace: expect.objectContaining({ workspacePath: "/repo" }), scope: "global" },
      expect.anything(),
    );
    service.disposeAll();
  });

  it("(b) 跳过远程 runtime，回落到管理面 workspace 载体", async () => {
    process.env.ZCODE_DATA_BASE_DIR = mkdtempSync(join(tmpdir(), "zcode-svc-carrier-"));
    const request = vi.fn(async (method: string) => replyForMethod(method));
    const { service, getClient } = await createServiceWithRequest(request);
    // 唯一活跃 runtime 是远程的（SSH identity + remoteSessionId）。
    await service.listSavedWorkflows({
      workspacePath: "/remote",
      workspaceIdentity: "remote:ssh:host",
      remoteSessionId: "s1",
    });
    expect(getClient).toHaveBeenCalledTimes(1);
    await service.listSavedWorkflows({ scope: "global" });
    // 远程不能当载体：拉管理面 client（第二次 getClient）。
    expect(getClient).toHaveBeenCalledTimes(2);
    const lastParams = request.mock.calls.at(-1)?.[1] as {
      scope?: string;
      workspace: { workspacePath: string };
    };
    expect(lastParams.scope).toBe("global");
    expect(lastParams.workspace.workspacePath).not.toBe("/remote");
    expect(lastParams.workspace.workspacePath).toContain("plugin-workspace");
    service.disposeAll();
  });

  it("(c) 没有任何本地 runtime 时回落到管理面 workspace 载体", async () => {
    process.env.ZCODE_DATA_BASE_DIR = mkdtempSync(join(tmpdir(), "zcode-svc-carrier-"));
    const request = vi.fn(async (method: string) => replyForMethod(method));
    const { service } = await createServiceWithRequest(request);
    await service.listSavedWorkflows({ scope: "global" });
    const lastParams = request.mock.calls.at(-1)?.[1] as {
      scope?: string;
      workspace: { workspacePath: string };
    };
    expect(lastParams.scope).toBe("global");
    expect(lastParams.workspace.workspacePath).toContain("plugin-workspace");
    service.disposeAll();
  });
});

// 完成卡的两个方法（docs/dynamic-workflow/transcript-and-notifications.md「Saving the run, and
// running it again」）：都**必带 workspace**，全局档也不例外——脚本在那个 agent 的 journal 里，
// 载体不能由 services 另选一个本机运行时。
describe("ZCodeAgentService saving a run", () => {
  it("saveSavedWorkflowFromRun → workflows/save，runId / meta / scope / overwrite 原样透传", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsSave) {
        return {
          ok: true,
          name: "pr-review",
          scope: "global",
          path: "/home/u/.zcode/workflows/pr-review.dwf.ts",
          overwritten: true,
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { service, getClient } = await createServiceWithRequest(request);
    await expect(
      service.saveSavedWorkflowFromRun({
        workspacePath: "/repo",
        runId: "run-1",
        name: "pr-review",
        meta: { description: "分层评审" },
        scope: "global",
        overwrite: true,
      }),
    ).resolves.toMatchObject({ ok: true, scope: "global", overwritten: true });
    // 全局档也走这条 workspace 的 client：不经载体选择。
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workflowsSave,
      {
        workspace: WORKSPACE,
        runId: "run-1",
        name: "pr-review",
        meta: { description: "分层评审" },
        scope: "global",
        overwrite: true,
      },
      expect.anything(),
    );
    service.disposeAll();
  });

  it("saveSavedWorkflowFromRun 缺省 scope / overwrite 时不带这两个键；拒绝是结果不是异常", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsSave) {
        return { ok: false, reason: "target_exists", path: "/repo/.zcode/workflows/x.dwf.ts" };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { service } = await createServiceWithRequest(request);
    await expect(
      service.saveSavedWorkflowFromRun({
        workspacePath: "/repo",
        runId: "run-1",
        name: "x",
        meta: { description: "d" },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "target_exists",
      path: "/repo/.zcode/workflows/x.dwf.ts",
    });
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workflowsSave,
      { workspace: WORKSPACE, runId: "run-1", name: "x", meta: { description: "d" } },
      expect.anything(),
    );
    service.disposeAll();
  });

  it("findSavedWorkflowForRun → workflows/forRun，候选在场才带", async () => {
    const entry = {
      name: "pr-review",
      description: "d",
      scope: "project" as const,
      path: "/repo/.zcode/workflows/pr-review.dwf.ts",
    };
    const request = vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.workflowsForRun) {
        return { entry, match: "candidate", runArgs: { base: "main" } };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { service } = await createServiceWithRequest(request);
    await expect(
      service.findSavedWorkflowForRun({
        workspacePath: "/repo",
        runId: "run-1",
        candidates: [{ name: "pr-review", scope: "project" }],
      }),
    ).resolves.toEqual({ entry, match: "candidate", runArgs: { base: "main" } });
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsForRun,
      {
        workspace: WORKSPACE,
        runId: "run-1",
        candidates: [{ name: "pr-review", scope: "project" }],
      },
      expect.anything(),
    );
    await service.findSavedWorkflowForRun({ workspacePath: "/repo", runId: "run-2" });
    expect(request).toHaveBeenLastCalledWith(
      zcodeProtocolMethods.workflowsForRun,
      { workspace: WORKSPACE, runId: "run-2" },
      expect.anything(),
    );
    service.disposeAll();
  });
});
