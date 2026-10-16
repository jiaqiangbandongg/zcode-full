import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  applyExternalTextInsertRequestToComposer,
  applyComposerRestoreRequestToComposer,
  restorePersistedComposerDraftIntoInput,
  type ComposerRestoreRequest,
} from "@/v4/ConversationComposer.js";
import {
  resolveQueuedComposerRestore,
  shouldRestoreQueuedComposerFromAck,
} from "@/v4/SessionPane.js";

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 7,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "primaryTurn",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: {
      autoDrain: true,
      items: [
        {
          queueItemId: "q-1",
          kind: "sendText",
          text: "排队原文",
          sourceCommandId: "cmd-q1",
          clientId: "cli",
          attachments: [
            { ref: "ref-b", fileName: "b.png", mime: "image/png", bytes: 2 },
            { ref: "ref-a", fileName: "a.txt", mime: "text/plain", bytes: 1 },
          ],
          delivery: { requested: "queue", admitted: "queue" },
          order: { admissionSeq: 1, queuePosition: 0 },
          steer: { state: "notRequested" },
          dispatch: { state: "queued" },
          admittedAt: 1,
        },
      ],
    },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

describe("v4 queue edit extraction", () => {
  it("Workspace 插件页重挂载时从共享草稿恢复结构化 mention", () => {
    const mention = {
      id: "plugin:document-skills@official",
      category: "plugins" as const,
      label: "文档技能",
      value: "document-skills@official",
      markdown: "[@文档技能](plugin://document-skills@official)",
      data: { pluginId: "document-skills@official" },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "unused"),
      setEditorStateJson: vi.fn(),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const text = `${mention.markdown} 整理文档`;

    expect(
      restorePersistedComposerDraftIntoInput({
        draft: { text, mention, updatedAt: 1 },
        inputApi,
      }),
    ).toBe(text);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " 整理文档");
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("插件 Skills 与独立 Skills 的 New 入口从共享草稿恢复 skill node", () => {
    const mention = {
      id: "skill:skill-creator",
      category: "skills" as const,
      label: "skill-creator",
      value: "skill-creator",
      markdown: "[$skill-creator](./.agents/skills/skill-creator/SKILL.md)",
      data: {
        path: ".agents/skills/skill-creator/SKILL.md",
        scope: "workspace" as const,
      },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "unused"),
      setEditorStateJson: vi.fn(),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const text = `${mention.markdown} `;

    expect(
      restorePersistedComposerDraftIntoInput({
        draft: { text, mention },
        inputApi,
      }),
    ).toBe(text);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " ");
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("新建技能把 canonical 前缀恢复为结构化 Skill mention 并保留尾空格", () => {
    const mention = {
      id: "skill:skill-creator",
      category: "skills" as const,
      label: "skill-creator",
      value: "skill-creator",
      markdown: "[$skill-creator](./.agents/skills/skill-creator/SKILL.md)",
      data: {
        path: ".agents/skills/skill-creator/SKILL.md",
        scope: "workspace" as const,
      },
    };
    const inputApi = {
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();
    const text = `${mention.markdown} `;

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: { requestId: 6, text, mention },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(6);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " ");
    expect(inputApi.setText).not.toHaveBeenCalled();
    expect(updateText).toHaveBeenCalledWith(text);
  });

  it("商店试用把 canonical 前缀恢复为结构化 Plugin mention", () => {
    const mention = {
      id: "plugin:demo@mkt",
      category: "plugins" as const,
      label: "Demo",
      value: "demo@mkt",
      markdown: "[@Demo](plugin://demo@mkt)",
      data: {
        pluginId: "demo@mkt",
        icon: "https://cdn.example.com/demo.png",
      },
    };
    const inputApi = {
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();
    const text = `${mention.markdown} Diagnose this workspace`;

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: { requestId: 7, text, mention },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(7);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " Diagnose this workspace");
    expect(inputApi.setText).not.toHaveBeenCalled();
    expect(updateText).toHaveBeenCalledWith(text);
    expect(scheduleDraftPersist).toHaveBeenCalledTimes(1);
    expect(requestFocus).toHaveBeenCalledTimes(1);
  });

  it("插件安装完成后把唯一 chip 前置到编辑器当前正文而不回放旧 prompt", () => {
    const mention = {
      id: "plugin:document-skills@zcode-plugins-official",
      category: "plugins" as const,
      label: "文档技能",
      value: "document-skills@zcode-plugins-official",
      markdown: "[@文档技能](plugin://document-skills@zcode-plugins-official)",
      data: { pluginId: "document-skills@zcode-plugins-official" },
    };
    const inputApi = {
      getMarkdown: vi.fn(
        () => `${mention.markdown} 用户安装期间编辑后的正文`,
      ),
      prependMentionIfMissing: vi.fn(() => true),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 8,
          text: mention.markdown,
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(8);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledWith(mention);
    expect(updateText).toHaveBeenCalledWith(`${mention.markdown} 用户安装期间编辑后的正文`);
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("当前草稿已有同一 Plugin canonical 文本时不重复插入 chip", () => {
    const mention = {
      id: "plugin:demo@mkt",
      category: "plugins" as const,
      label: "Demo",
      value: "demo@mkt",
      markdown: "[@Demo](plugin://demo@mkt)",
      data: { pluginId: "demo@mkt" },
    };
    const inputApi = {
      // label 是 display-only；即使语言切换导致 label 不同，同一 stable ID 也不能重复插入。
      getMarkdown: vi.fn(() => "[@旧名称](plugin://demo@mkt) 当前正文"),
      prependMentionIfMissing: vi.fn(() => false),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 9,
          text: mention.markdown,
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus: vi.fn(),
        scheduleDraftPersist: vi.fn(),
        updateText,
      }),
    ).toBe(9);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledWith(mention);
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(updateText).not.toHaveBeenCalled();
  });

  it("PA158 撤回使用队列项自身权限/Plan/模型，不借用当前 Composer 配置", () => {
    const snapshot = makeSnapshot();
    Object.assign(snapshot.queue.items[0]!, {
      mode: "yolo",
      planEnabled: false,
      modelSelection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
    expect(resolveQueuedComposerRestore(snapshot, "q-1")?.config).toEqual({
      mode: "yolo",
      planEnabled: false,
      modelSelection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("提取完整输入并保持附件顺序，供权威删除后恢复 composer", () => {
    expect(resolveQueuedComposerRestore(makeSnapshot(), "q-1")).toEqual({
      baseRevision: 7,
      queueItemId: "q-1",
      sourceCommandId: "cmd-q1",
      inputKind: "sendText",
      text: "排队原文",
      attachments: [
        { ref: "ref-b", fileName: "b.png", mime: "image/png", bytes: 2 },
        { ref: "ref-a", fileName: "a.txt", mime: "text/plain", bytes: 1 },
      ],
    });
    expect(resolveQueuedComposerRestore(makeSnapshot(), "missing")).toBeNull();
  });

  it("goal 恢复可见 slash 文本，compact 明确剪枝", () => {
    const goal = makeSnapshot();
    goal.queue.items[0] = {
      ...goal.queue.items[0]!,
      kind: "sendGoalCommand",
      text: "修复登录",
    };
    expect(resolveQueuedComposerRestore(goal, "q-1")?.text).toBe("/goal 修复登录");

    const compact = makeSnapshot();
    compact.queue.items[0] = {
      ...compact.queue.items[0]!,
      kind: "compact",
      text: "/compact",
      attachments: [],
    };
    expect(resolveQueuedComposerRestore(compact, "q-1")).toBeNull();
  });

  it("只允许 accepted/duplicate 恢复，其他 ACK 分支保持 composer 不变", () => {
    expect(shouldRestoreQueuedComposerFromAck("accepted")).toBe(true);
    expect(shouldRestoreQueuedComposerFromAck("duplicate")).toBe(true);
    expect(shouldRestoreQueuedComposerFromAck("noop")).toBe(false);
    expect(shouldRestoreQueuedComposerFromAck("stale")).toBe(false);
    expect(shouldRestoreQueuedComposerFromAck("rejected")).toBe(false);
    expect(shouldRestoreQueuedComposerFromAck("failed")).toBe(false);
  });

  it("只在绑定 session/workspace 的空 composer 幂等恢复文字与附件", () => {
    const request: ComposerRestoreRequest = {
      requestId: 1,
      sessionId: "session-1",
      workspaceKey: "remote:ssh:host:/workspace",
      inputKind: "sendText",
      text: "排队原文",
      attachments: [{ ref: "ref-1", fileName: "a.png", mime: "image/png", bytes: 1 }],
      config: { mode: "yolo", planEnabled: false },
    };
    const inputApi = {
      focus: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();
    const restoreSessionOwnedAttachments = vi.fn(() => true);
    const restoreDraftConfig = vi.fn();

    expect(
      applyComposerRestoreRequestToComposer({
        appliedRequestId: null,
        currentSessionId: "session-1",
        currentWorkspaceKey: "remote:ssh:host:/workspace",
        hasDraftContent: false,
        inputApi,
        request,
        requestFocus,
        restoreSessionOwnedAttachments,
        restoreDraftConfig,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(1);
    expect(inputApi.setText).toHaveBeenCalledWith("排队原文");
    expect(updateText).toHaveBeenCalledWith("排队原文");
    expect(requestFocus).toHaveBeenCalledTimes(1);
    expect(scheduleDraftPersist).toHaveBeenCalledTimes(1);
    expect(restoreSessionOwnedAttachments).toHaveBeenCalledWith(request.attachments);

    expect(
      applyComposerRestoreRequestToComposer({
        appliedRequestId: 1,
        currentSessionId: "session-1",
        currentWorkspaceKey: "remote:ssh:host:/workspace",
        hasDraftContent: false,
        inputApi,
        request,
        requestFocus,
        restoreSessionOwnedAttachments,
        restoreDraftConfig,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(1);
    expect(inputApi.setText).toHaveBeenCalledTimes(1);
    expect(restoreSessionOwnedAttachments).toHaveBeenCalledTimes(1);

    expect(
      applyComposerRestoreRequestToComposer({
        appliedRequestId: null,
        currentSessionId: "session-other",
        currentWorkspaceKey: "remote:ssh:host:/workspace",
        hasDraftContent: false,
        inputApi,
        request,
        requestFocus,
        restoreSessionOwnedAttachments,
        restoreDraftConfig,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBeNull();
    expect(
      applyComposerRestoreRequestToComposer({
        appliedRequestId: null,
        currentSessionId: "session-1",
        currentWorkspaceKey: "remote:ssh:host:/workspace",
        hasDraftContent: true,
        inputApi,
        request,
        requestFocus,
        restoreSessionOwnedAttachments,
        restoreDraftConfig,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBeNull();
    expect(inputApi.setText).toHaveBeenCalledTimes(1);
    expect(restoreDraftConfig).toHaveBeenCalledExactlyOnceWith(request.config);
  });
});
