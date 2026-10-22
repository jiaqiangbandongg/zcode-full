import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearV4ComposerDraft,
  clearV4ComposerDraftTaskGroup,
  getV4ComposerDraftStorageKey,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  ensurePendingTaskDraft,
  readPendingTaskDraft,
  completePendingTaskDraft,
  bindPendingTaskDraft,
} from "@/v4/composer/composerDraftStore.js";

const selection = {
  providerId: "personal-provider",
  modelId: "model-a",
  options: { reasoningLevel: "high" },
};
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
};
const workspace = "/workspace";
const read = (scope = "session-a") => readV4ComposerDraft(workspace, undefined, scope);

describe("Composer Draft 持久选择", () => {
  it("关闭项目分组草稿只修改该项目，不影响同目录其他项目", () => {
    const p = { clientNamespace: "desktop", hostId: "local", projectId: "p" };
    const q = { ...p, projectId: "q" };
    for (const scope of [p, q])
      persistV4ComposerDraft(
        workspace,
        undefined,
        V4_DRAFT_SCOPE_ROOT,
        { text: scope.projectId, taskGroupId: "g" },
        scope,
      );
    clearV4ComposerDraftTaskGroup(workspace, undefined, p);
    expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, p)).toMatchObject({
      text: "p",
    });
    expect(
      readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, p)?.taskGroupId,
    ).toBeUndefined();
    expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, q)?.taskGroupId).toBe(
      "g",
    );
  });
  it("关闭分组草稿行只清理分组意图，保留正文、项目与模型", () => {
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "继续编辑",
      projectId: "p",
      taskGroupId: "g",
      modelSelection: selection,
    });
    clearV4ComposerDraftTaskGroup(workspace, undefined);
    expect(read(V4_DRAFT_SCOPE_ROOT)).toMatchObject({
      text: "继续编辑",
      projectId: "p",
      modelSelection: selection,
    });
    expect(read(V4_DRAFT_SCOPE_ROOT)?.taskGroupId).toBeUndefined();
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, { text: "继续输入" });
    expect(read(V4_DRAFT_SCOPE_ROOT)?.taskGroupId).toBeUndefined();
  });
  it("PD01/07 未发送目录引用稳定，旧接纳不能清理下一份草稿", () => {
    const scope = { clientNamespace: "desktop", hostId: "local", projectId: null };
    const a = ensurePendingTaskDraft(scope);
    expect(ensurePendingTaskDraft(scope).draftId).toBe(a.draftId);
    bindPendingTaskDraft(scope, a.draftId, "/task-a");
    expect(readPendingTaskDraft(scope)?.workspacePath).toBe("/task-a");
    completePendingTaskDraft(scope, "stale");
    expect(readPendingTaskDraft(scope)?.draftId).toBe(a.draftId);
    completePendingTaskDraft(scope, a.draftId);
    const b = ensurePendingTaskDraft(scope);
    expect(b.draftId).not.toBe(a.draftId);
    completePendingTaskDraft(scope, a.draftId);
    expect(readPendingTaskDraft(scope)?.draftId).toBe(b.draftId);
    expect(readV4ComposerDraft("/task-a", undefined, V4_DRAFT_SCOPE_ROOT, scope)).toBeNull();
  });
  it("PD03 同目录项目草稿独立，项目更换主要目录仍能恢复", () => {
    const p = { clientNamespace: "desktop", hostId: "local", projectId: "p" };
    const q = { ...p, projectId: "q" };
    persistV4ComposerDraft(
      workspace,
      undefined,
      V4_DRAFT_SCOPE_ROOT,
      { text: "P", projectId: "p", mode: "yolo", modelSelection: selection },
      p,
    );
    persistV4ComposerDraft(
      workspace,
      undefined,
      V4_DRAFT_SCOPE_ROOT,
      { text: "Q", projectId: "q" },
      q,
    );
    expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, p)?.text).toBe("P");
    expect(
      readV4ComposerDraft("/new-root", undefined, V4_DRAFT_SCOPE_ROOT, p)?.modelSelection,
    ).toEqual(selection);
    clearV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, q);
    expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, p)?.text).toBe("P");
    expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, q)).toBeNull();
  });

  it("PD10 项目、任务、主机与客户端范围隔离，正式 session 保持原 key", () => {
    const task = { clientNamespace: "desktop", hostId: "local", projectId: null };
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, { text: "task" }, task);
    expect(readV4ComposerDraft("/another", undefined, V4_DRAFT_SCOPE_ROOT, task)?.text).toBe(
      "task",
    );
    for (const scope of [
      { ...task, projectId: "p" },
      { ...task, hostId: "remote" },
      { ...task, clientNamespace: "mobile" },
    ]) {
      expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, scope)).toBeNull();
    }
    expect(readV4ComposerDraft(workspace, undefined, "session-a", task)).toBeNull();
    persistV4ComposerDraft(workspace, undefined, "session-a", { text: "session" }, task);
    expect(read("session-a")?.text).toBe("session");
  });

  it("PD11 旧草稿只在项目归属相符时读取，显式保存后不复活旧内容", () => {
    const p = { clientNamespace: "desktop", hostId: "local", projectId: "p" };
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "legacy",
      projectId: "p",
    });
    expect(
      readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, { ...p, projectId: "q" }),
    ).toBeNull();
    expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, p)?.text).toBe("legacy");
    persistV4ComposerDraft(
      workspace,
      undefined,
      V4_DRAFT_SCOPE_ROOT,
      { text: "", projectId: "p" },
      p,
    );
    expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, p)).toBeNull();
    expect(readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT)?.text).toBe("legacy");
    // 迁移后的删除不能靠删除旧存储完成；旧数据保留且不能再次认领。
    expect(readV4ComposerDraft("/new-root", undefined, V4_DRAFT_SCOPE_ROOT, p)).toBeNull();
  });

  it("PD11 新格式草稿清空后换主要目录，也不能重新认领旧文字", () => {
    const scope = { clientNamespace: "desktop", hostId: "local", projectId: "p" };
    persistV4ComposerDraft("/old-root", undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "legacy",
      projectId: "p",
    });
    persistV4ComposerDraft("/new-root", undefined, V4_DRAFT_SCOPE_ROOT, { text: "new" }, scope);
    clearV4ComposerDraft("/new-root", undefined, V4_DRAFT_SCOPE_ROOT, scope);
    expect(readV4ComposerDraft("/old-root", undefined, V4_DRAFT_SCOPE_ROOT, scope)).toBeNull();
  });

  it.each(["", " \n\t"])("TD01 空正文 %j 不因配置或元数据写盘", (text) => {
    const write = vi.spyOn(storage, "setItem");
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text,
      mode: "yolo",
      modelSelection: selection,
      editorStateJson: "{}",
      projectId: "project",
      taskGroupId: "group",
    });
    expect(read(V4_DRAFT_SCOPE_ROOT)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("TD04 删空后移除记录，保留其他 Session 的文字草稿", () => {
    persistV4ComposerDraft(workspace, undefined, "other", { text: "keep", mode: "build" });
    persistV4ComposerDraft(workspace, undefined, "session-a", { text: "draft", mode: "yolo" });
    persistV4ComposerDraft(workspace, undefined, "session-a", { text: " ", mode: "yolo" });
    expect(read()).toBeNull();
    expect(read("other")?.text).toBe("keep");
  });

  it("CS08 读取不写盘，显式写入清理旧空白记录并保留有文字草稿", () => {
    const key = getV4ComposerDraftStorageKey(workspace);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        scopes: {
          __draft__: { text: "", mode: "yolo", modelSelection: selection, updatedAt: 1 },
          other: { text: "keep", mode: "build", updatedAt: 2 },
        },
      }),
    );
    const write = vi.spyOn(storage, "setItem");
    const remove = vi.spyOn(storage, "removeItem");
    expect(read(V4_DRAFT_SCOPE_ROOT)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, { text: "" });
    expect(JSON.parse(storage.getItem(key)!).scopes.__draft__).toBeUndefined();
    expect(read("other")?.text).toBe("keep");
  });

  it("分组 placement 独立保留，切项目/改正文不丢失，提升后不保留副本", () => {
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "draft",
      taskGroupId: "group-a",
      projectId: "p",
    });
    const captured = read(V4_DRAFT_SCOPE_ROOT)?.taskGroupId;
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "hello",
      projectId: "p2",
    });
    expect(read(V4_DRAFT_SCOPE_ROOT)?.taskGroupId).toBe("group-a");
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "draft",
      taskGroupId: "group-b",
    });
    expect(captured).toBe("group-a");
    persistV4ComposerDraft(workspace, undefined, "real-task", {
      text: "draft",
      taskGroupId: "group-a",
    });
    expect(read("real-task")?.taskGroupId).toBeUndefined();
  });
  it("项目归属在文字草稿、正文/模型更新时保留，显式未分类和 promotion 清理生效", () => {
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "draft",
      projectId: "p",
    });
    expect(read(V4_DRAFT_SCOPE_ROOT)?.projectId).toBe("p");
    persistV4ComposerDraft(workspace, undefined, "promoted", { text: "sent", projectId: "p" });
    expect(read("promoted")?.projectId).toBeUndefined();
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "new text",
      mode: "build",
      modelSelection: selection,
    });
    expect(read(V4_DRAFT_SCOPE_ROOT)?.projectId).toBe("p");
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "draft",
      projectId: null,
    });
    expect(read(V4_DRAFT_SCOPE_ROOT)?.projectId).toBeNull();
    clearV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT);
    expect(read(V4_DRAFT_SCOPE_ROOT)).toBeNull();
  });
  it("旧事件消费字段与初始化标记不再参与文字恢复", () => {
    storage.setItem(
      getV4ComposerDraftStorageKey(workspace),
      JSON.stringify({
        version: 1,
        scopes: {
          "session-a": {
            text: "keep",
            mode: "build",
            initializeFromNewTask: true,
            lastPermissionGrantId: "old",
            lastPlanTransitionId: "old",
            updatedAt: 1,
          },
        },
      }),
    );
    expect(read()).toEqual({ text: "keep", mode: "build", planEnabled: false, updatedAt: 1 });
  });
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", { localStorage: storage });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("文字草稿保留已初始化的空选择", () => {
    persistV4ComposerDraft(workspace, undefined, "session-a", { text: "draft", mode: "build" });
    expect(read()).toMatchObject({ text: "draft", mode: "build" });
    expect(read()?.modelSelection).toBeUndefined();
  });

  it("发送后清空正文也删除持久配置", () => {
    const draft = { text: "prompt", mode: "plan" as const, modelSelection: selection };
    persistV4ComposerDraft(workspace, undefined, "session-a", draft);
    persistV4ComposerDraft(workspace, undefined, "session-a", { ...draft, text: "" });
    expect(read()).toBeNull();
  });

  it("同路径不同远端与 Root/Session scope 互相隔离", () => {
    persistV4ComposerDraft(workspace, "remote-a", V4_DRAFT_SCOPE_ROOT, {
      text: "draft",
      mode: "edit",
    });
    persistV4ComposerDraft(workspace, "remote-b", V4_DRAFT_SCOPE_ROOT, {
      text: "draft",
      mode: "plan",
    });
    persistV4ComposerDraft(workspace, "remote-a", "session-a", { text: "draft", mode: "yolo" });
    expect(readV4ComposerDraft("/other-path", "remote-a", V4_DRAFT_SCOPE_ROOT)?.mode).toBe("edit");
    expect(readV4ComposerDraft(workspace, "remote-b", V4_DRAFT_SCOPE_ROOT)).toMatchObject({
      mode: "build",
      planEnabled: true,
    });
    expect(readV4ComposerDraft(workspace, "remote-a", "session-a")?.mode).toBe("yolo");
    expect(read()).toBeNull();
  });

  it("冷启动初始化 Root scope 时保留已有 Session scope", () => {
    persistV4ComposerDraft(workspace, undefined, "session-a", {
      text: "draft",
      mode: "edit",
      modelSelection: {
        providerId: "e2e-deepseek",
        modelId: "deepseek-v4-flash",
        options: { reasoningLevel: "max" },
      },
    });
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "draft",
      mode: "build",
      modelSelection: {
        providerId: "e2e-deepseek",
        modelId: "deepseek-v4-flash",
        options: { reasoningLevel: "max" },
      },
    });
    expect(read("session-a")).toMatchObject({ mode: "edit" });
    expect(read(V4_DRAFT_SCOPE_ROOT)).toMatchObject({ mode: "build" });
  });

  it("兼容旧文本草稿，按叶子隔离损坏的当前选择", () => {
    storage.setItem(
      getV4ComposerDraftStorageKey(workspace),
      JSON.stringify({
        version: 1,
        scopes: {
          old: { text: "old text", editorStateJson: "{}", updatedAt: 1 },
          "session-a": {
            text: "keep",
            mode: "edit",
            modelSelection: { ...selection, options: 7 },
            updatedAt: 2,
          },
          invalid: { text: 42, mode: "edit", updatedAt: 3 },
        },
      }),
    );
    expect(read("old")).toEqual({ text: "old text", editorStateJson: "{}", updatedAt: 1 });
    expect(read()?.modelSelection).toEqual({
      providerId: selection.providerId,
      modelId: selection.modelId,
    });
    expect(read()?.mode).toBe("edit");
    expect(read("invalid")).toBeNull();
  });

  it("长期使用的模型选择不会因 scope 数量被静默淘汰", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++now);
    for (let index = 0; index < 501; index++) {
      persistV4ComposerDraft(workspace, undefined, `scope-${index}`, {
        text: "draft",
        mode: "build",
      });
      if (index === 50 || index === 499) expect(read("scope-0")).not.toBeNull();
    }
    expect(read("scope-0")).not.toBeNull();
    expect(read("scope-1")?.mode).toBe("build");
    expect(read("scope-500")?.mode).toBe("build");
  });

  it("存储不可读不能让 Composer 崩溃", () => {
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(() => read()).not.toThrow();
    expect(read()).toBeNull();
  });
});
