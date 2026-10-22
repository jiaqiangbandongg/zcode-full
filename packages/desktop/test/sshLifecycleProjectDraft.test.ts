import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectSSHWorkspaceAndSendFirstTurn } from "#e2e/helpers/ssh-remote-lifecycle";

const state = vi.hoisted(() => {
  const sent: Array<{ identity: string; model: string }> = [];
  return {
    identity: "",
    model: "local-default",
    localDraftCreations: 0,
    remoteIdentity: "remote:server:fixture:/work",
    sent,
  };
});

vi.mock("#e2e/helpers/project-sidebar", () => ({}));
vi.mock("#e2e/helpers/desktop-app", () => ({ waitForWorkspaceApp: vi.fn() }));
vi.mock("#e2e/helpers/custom-openai-provider", () => ({}));
vi.mock("#e2e/helpers/upstream-provider", () => ({
  selectUpstreamProviderModelById: async (model: string) => {
    state.model = model;
  },
  selectUpstreamThoughtLevelValue: vi.fn(),
}));
vi.mock("#e2e/helpers/conversation-session-network", () => ({
  getUpstreamRequestRecordCount: async () => state.sent.length,
  waitForUpstreamRequest: vi.fn(),
}));
vi.mock("#e2e/helpers/v4-conversation", () => ({
  // 全局新建按产品合同切换到本地未分类任务，不能冒充远程项目内新建。
  startNewV4Draft: async () => {
    state.localDraftCreations += 1;
    state.identity = "";
    state.model = "local-default";
  },
  sendV4PromptAndWaitAccepted: async () => {
    state.sent.push({ identity: state.identity, model: state.model });
  },
  waitForV4ConversationState: async (predicate: (value: unknown) => boolean) => {
    const snapshot = {
      taskId: state.identity ? "remote-task" : "local-task",
      state: "idle",
      queueCount: 0,
    };
    expect(predicate(snapshot)).toBe(true);
    return snapshot;
  },
  waitForV4AssistantMessageContaining: vi.fn(),
}));
vi.mock("#e2e/helpers/ssh-remote-p0", () => ({
  SSH_WORKSPACE_READY_TIMEOUT_MS: 1_000,
  clickLastEnabledSSHDialogButton: vi.fn(),
  fillSSHPasswordSettings: vi.fn(),
  openSSHRemoteDialog: vi.fn(),
  ensureSSHProjectDirectoryStep: vi.fn(),
  selectSSHRemoteDirectory: async () => {
    state.identity = state.remoteIdentity;
  },
  waitForRemoteTab: async () => ({
    remoteKind: "ssh",
    remoteHost: "127.0.0.1",
    remoteSessionId: "attachment",
    secretPersistedInTab: false,
    workspaceIdentity: state.remoteIdentity,
  }),
  readRemoteTabSnapshot: async () => ({
    activeWorkspaceIdentity: state.identity || null,
    activeWorkspacePath: state.identity ? "/work" : "/local",
  }),
}));

beforeEach(() => {
  vi.stubGlobal("expect", expect);
  state.identity = "";
  state.model = "local-default";
  state.localDraftCreations = 0;
  state.sent.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

it("远程项目首发保留新建项目草稿和已选模型，不跳到全局本地任务", async () => {
  const task = await connectSSHWorkspaceAndSendFirstTurn({
    caseMarker: "E2E_REMOTE_DRAFT",
    config: { host: "127.0.0.1", port: 43210, username: "dev", password: "fixture" },
    label: "A",
    workspacePath: "/work",
    provider: {
      id: "fixture-provider",
      name: "Fixture provider",
      tunnel: { baseURL: "http://127.0.0.1:43211", close: async () => {} },
    },
  });
  expect(state.sent).toEqual([
    { identity: state.remoteIdentity, model: "e2e-ssh-remote-lifecycle-model" },
  ]);
  expect(task.taskId).toBe("remote-task");
  expect(task.identity).toBe(state.remoteIdentity);
  expect(state.localDraftCreations).toBe(0);
});
