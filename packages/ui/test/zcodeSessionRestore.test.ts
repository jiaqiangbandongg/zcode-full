import { describe, expect, it, vi } from "vitest";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  type ZCodeMessageWithParts,
  type ZCodeSessionStateSnapshot,
  type ZCodeTaskSnapshot,
} from "@zcode/shared";
import {
  readDesktopContinuousSessionRestoreSnapshot,
  readWebRemoteReplayableSessionConfigOptions,
} from "../src/lib/zcodeSessionRestore.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceIdentity: "ssh://dev/workspace/app",
  workspaceKey: "ssh://dev/workspace/app",
};

const model = { providerId: "glm", modelId: "glm-4.6" };

function createSnapshot(params: {
  title?: string;
  messages?: ZCodeMessageWithParts[];
} = {}): ZCodeSessionStateSnapshot {
  return {
    protocol: {
      name: ZCODE_PROTOCOL_NAME,
      version: ZCODE_PROTOCOL_VERSION,
    },
    session: {
      sessionId: "sess_1",
      workspace,
      sessionKind: "interactive",
      title: params.title ?? "Existing session",
      mode: "build",
      status: "idle",
      model,
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: {
        current: model,
        available: [{ ref: model, label: "GLM 4.6" }],
      },
      thoughtLevel: {
        enabled: false,
        available: [],
      },
      mode: {
        current: "build",
      },
    },
    projection: {
      sessionId: "sess_1",
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 128000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: {
      eventSeq: 0,
      stateRevision: 1,
      deliveryKind: "desktop-continuous",
      pendingRequestIds: [],
    },
    messages: params.messages ?? [],
  };
}

function createLegacyTaskSnapshot(): ZCodeTaskSnapshot {
  return {
    meta: {
      taskId: "sess_1",
      traceId: "trace-legacy",
      title: "Legacy task",
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      createdAt: 1,
      updatedAt: 2,
      mode: "build",
      provider: "glm",
      status: "completed",
    },
    messages: [
      {
        role: "user",
        content: "old prompt",
        timestamp: 1,
      },
    ],
  };
}

describe("readDesktopContinuousSessionRestoreSnapshot", () => {
  it("resumes historical desktop session before reading the limited snapshot", async () => {
    const calls: string[] = [];
    let active = false;
    const zcodeSessionService = {
      resumeSession: vi.fn(async () => {
        calls.push("resume");
        active = true;
        return createSnapshot({ title: "Resumed session" });
      }),
      readSession: vi.fn(async () => {
        calls.push("read");
        if (!active) {
          throw new Error("Session is not active: sess_1");
        }
        return createSnapshot({ title: "Read session" });
      }),
    };

    const restoreParams: Parameters<typeof readDesktopContinuousSessionRestoreSnapshot>[0] = {
      zcodeSessionService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      messageLimit: 30,
      model: { providerId: "custom-openai", modelId: "deepseek-v4-flash" },
      thoughtLevel: "high",
    };

    const result = await readDesktopContinuousSessionRestoreSnapshot(restoreParams);

    expect(calls).toEqual(["resume", "read"]);
    expect(zcodeSessionService.resumeSession).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      model: { providerId: "custom-openai", modelId: "deepseek-v4-flash" },
      thoughtLevel: "high",
    });
    expect(zcodeSessionService.readSession).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      deliveryKind: "desktop-continuous",
      messageLimit: 30,
    });
    expect(result.resumedSessionSnapshot?.session.title).toBe("Resumed session");
    expect(result.snapshot.meta.title).toBe("Read session");
  });

  it("falls back to legacy task snapshot when the protocol session is missing", async () => {
    const legacySnapshot = createLegacyTaskSnapshot();
    const zcodeSessionService = {
      resumeSession: vi.fn(async () => {
        throw new Error("Session not found: sess_1");
      }),
      readSession: vi.fn(async () => createSnapshot()),
    };
    const zcodeTaskService = {
      getTaskSnapshot: vi.fn(async () => legacySnapshot),
    };

    const result = await readDesktopContinuousSessionRestoreSnapshot({
      zcodeSessionService,
      zcodeTaskService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      messageLimit: 30,
    });

    expect(result.usedLegacySnapshot).toBe(true);
    expect(result.resumedSessionSnapshot).toBeUndefined();
    expect(result.snapshot.meta.title).toBe("Legacy task");
    expect(zcodeSessionService.readSession).not.toHaveBeenCalled();
    expect(zcodeTaskService.getTaskSnapshot).toHaveBeenCalledWith({
      taskId: "sess_1",
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      messageLimit: 30,
      clientMode: "desktop-continuous",
    });
  });

  it("falls back to task snapshot when the historical runtime model is unavailable", async () => {
    const legacySnapshot = createLegacyTaskSnapshot();
    const unavailableModelError = Object.assign(
      new Error("历史任务使用的模型已不可用，请选择当前可用模型后继续。"),
      { code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE" },
    );
    const zcodeSessionService = {
      resumeSession: vi.fn(async () => {
        throw unavailableModelError;
      }),
      readSession: vi.fn(async () => createSnapshot()),
    };
    const zcodeTaskService = {
      getTaskSnapshot: vi.fn(async () => legacySnapshot),
    };

    const result = await readDesktopContinuousSessionRestoreSnapshot({
      zcodeSessionService,
      zcodeTaskService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      messageLimit: 30,
      model: { providerId: "removed-provider", modelId: "removed-model" },
    });

    expect(result.usedLegacySnapshot).toBe(true);
    expect(result.resumedSessionSnapshot).toBeUndefined();
    expect(result.restoreWarning).toMatchObject({
      code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
      message: "历史任务使用的模型已不可用，请选择当前可用模型后继续。",
      taskId: "sess_1",
    });
    expect(result.snapshot.meta.title).toBe("Legacy task");
    expect(zcodeSessionService.readSession).not.toHaveBeenCalled();
    expect(zcodeTaskService.getTaskSnapshot).toHaveBeenCalledWith({
      taskId: "sess_1",
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      messageLimit: 30,
      clientMode: "desktop-continuous",
    });
  });
});

describe("readWebRemoteReplayableSessionConfigOptions", () => {
  it("resumes with the historical model before reading active mobile task toolbar settings", async () => {
    const calls: string[] = [];
    const historicalModel = {
      providerId: "china-llm-zcode-dev:demo",
      modelId: "deepseek-v4-flash",
    };
    const zcodeSessionService = {
      resumeSession: vi.fn(async () => {
        calls.push("resume");
        return createSnapshot({ title: "Mobile resumed session" });
      }),
      readSession: vi.fn(async () => {
        calls.push("read");
        return createSnapshot({
          title: "Mobile session",
        });
      }),
    };

    const restoreParams: Parameters<typeof readWebRemoteReplayableSessionConfigOptions>[0] = {
      zcodeSessionService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      model: historicalModel,
      thoughtLevel: "high",
    };

    const configOptions = await readWebRemoteReplayableSessionConfigOptions(restoreParams);

    expect(calls).toEqual(["resume", "read"]);
    expect(zcodeSessionService.resumeSession).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      model: historicalModel,
      thoughtLevel: "high",
    });
    expect(zcodeSessionService.readSession).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      deliveryKind: "web-remote-replayable",
      messageLimit: 1,
    });
    expect(configOptions?.map((option) => option.category)).toEqual([
      "model",
      "mode",
    ]);
  });

  it("includes thought level from replayable session settings when enabled", async () => {
    const snapshot = createSnapshot();
    const zcodeSessionService = {
      readSession: vi.fn(async () => ({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          thoughtLevel: {
            enabled: true,
            current: "high",
            available: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        },
      })),
      resumeSession: vi.fn(),
    };

    const configOptions = await readWebRemoteReplayableSessionConfigOptions({
      zcodeSessionService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
    });

    expect(configOptions?.map((option) => option.category)).toEqual([
      "model",
      "mode",
      "thought_level",
    ]);
    expect(
      configOptions?.find((option) => option.category === "thought_level")
        ?.currentValue,
    ).toBe("high");
  });

  it("returns null for legacy tasks without an active protocol session", async () => {
    const zcodeSessionService = {
      readSession: vi.fn(async () => {
        throw new Error("Session not found: sess_1");
      }),
      resumeSession: vi.fn(),
    };

    await expect(
      readWebRemoteReplayableSessionConfigOptions({
        zcodeSessionService,
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        sessionId: "sess_1",
      }),
    ).resolves.toBeNull();
  });
});
