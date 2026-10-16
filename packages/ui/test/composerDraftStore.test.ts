import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearV4ComposerDraft,
  getV4ComposerDraftStorageKey,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
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
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", { localStorage: storage });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("空文本仍保留 mode、选择；显式清理才删除 scope", () => {
    persistV4ComposerDraft(workspace, undefined, "session-a", {
      text: "",
      mode: "edit",
      modelSelection: selection,
    });
    expect(read()).toMatchObject({ text: "", mode: "edit", modelSelection: selection });
    clearV4ComposerDraft(workspace, undefined, "session-a");
    expect(read()).toBeNull();
  });

  it("初始化过的空选择持久保留，mode 区分它与旧文本草稿", () => {
    persistV4ComposerDraft(workspace, undefined, "session-a", { text: "", mode: "build" });
    expect(read()).toMatchObject({ text: "", mode: "build" });
    expect(read()?.modelSelection).toBeUndefined();
  });

  it("清空已发送文本不会删除执行选择", () => {
    const draft = { text: "prompt", mode: "plan" as const, modelSelection: selection };
    persistV4ComposerDraft(workspace, undefined, "session-a", draft);
    persistV4ComposerDraft(workspace, undefined, "session-a", { ...draft, text: "" });
    expect(read()).toMatchObject({
      text: "",
      mode: "build",
      planEnabled: true,
      modelSelection: selection,
    });
  });

  it("同路径不同远端与 Root/Session scope 互相隔离", () => {
    persistV4ComposerDraft(workspace, "remote-a", V4_DRAFT_SCOPE_ROOT, { text: "", mode: "edit" });
    persistV4ComposerDraft(workspace, "remote-b", V4_DRAFT_SCOPE_ROOT, { text: "", mode: "plan" });
    persistV4ComposerDraft(workspace, "remote-a", "session-a", { text: "", mode: "yolo" });
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
      text: "",
      mode: "edit",
      modelSelection: {
        providerId: "e2e-deepseek",
        modelId: "deepseek-v4-flash",
        options: { reasoningLevel: "max" },
      },
    });
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "",
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
      persistV4ComposerDraft(workspace, undefined, `scope-${index}`, { text: "", mode: "build" });
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
