// 完成卡「保存 / 再次运行」的纯逻辑（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
// run, and running it again」）：名字规则的前置回声、落点预览、弹层起点、交给 ZCode 的那条消息、
// 转写里的候选联接、「再次运行」实参预填，以及「这次 run 存成了哪个工作流」的读缓存。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES } from "@zcode/shared";

vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

// eslint-disable-next-line import/first -- 必须在 logger mock 之后再引入。
import {
  SAVED_WORKFLOW_NAME_MAX_CHARS,
  buildWorkflowSaveRequestPrompt,
  initialWorkflowSaveDraft,
  isValidSavedWorkflowNameText,
  savedWorkflowPathPreview,
} from "@/components/workflow-timeline/workflowRunSave.js";
// eslint-disable-next-line import/first
import { buildWorkflowSaveCandidatesByRunId } from "@/v4/workflowRunCardJoin.js";
// eslint-disable-next-line import/first
import { buildSavedWorkflowArgFields } from "@/settings/saved-workflows/savedWorkflowArgsForm.js";
// eslint-disable-next-line import/first
import {
  resetWorkflowRunSavedStoreForTests,
  selectWorkflowRunSavedState,
  useWorkflowRunSavedStore,
  workflowRunSavedKey,
} from "@/store/workflowRunSavedStore.js";
// eslint-disable-next-line import/first -- 词条只用于双语言存在性断言。
import enUS from "../src/i18n/locales/en-US.js";
// eslint-disable-next-line import/first
import zhCN from "../src/i18n/locales/zh-CN.js";

afterEach(() => {
  resetWorkflowRunSavedStoreForTests();
});

describe("名字规则的前置回声", () => {
  it("与 agent 的 isValidSavedWorkflowName 同形：字符集、长度、不能只有点", () => {
    expect(isValidSavedWorkflowNameText("pr-review_v2.1")).toBe(true);
    expect(isValidSavedWorkflowNameText("a".repeat(SAVED_WORKFLOW_NAME_MAX_CHARS))).toBe(true);
    for (const bad of [
      "",
      "a".repeat(SAVED_WORKFLOW_NAME_MAX_CHARS + 1),
      "..",
      ".",
      "../escape",
      "a/b",
      "有中文",
      "with space",
    ]) {
      expect(isValidSavedWorkflowNameText(bad)).toBe(false);
    }
  });

  it("落点预览：项目档相对路径，全局档 ~ 开头（agent 机器的家目录）", () => {
    expect(savedWorkflowPathPreview("project", "x")).toBe(".zcode/workflows/x.dwf.ts");
    expect(savedWorkflowPathPreview("global", "x")).toBe("~/.zcode/workflows/x.dwf.ts");
  });
});

describe("弹层起点", () => {
  it("run 名本身是合法文件名时预填名字；说明总是预填 run 名", () => {
    expect(initialWorkflowSaveDraft({ runName: "pr-review" })).toEqual({
      name: "pr-review",
      scope: "project",
      description: "pr-review",
    });
  });

  it("用户语言起的 run 名不进名字框（那只会得到一个必然报错的值），但进说明", () => {
    expect(initialWorkflowSaveDraft({ runName: " PR 分层评审 · 安全 " })).toEqual({
      name: "",
      scope: "project",
      description: "PR 分层评审 · 安全",
    });
    expect(initialWorkflowSaveDraft({ scope: "global" })).toEqual({
      name: "",
      scope: "global",
      description: "",
    });
  });
});

describe("交给 ZCode 的那条消息", () => {
  const base = { runId: "dwfrun-7", runName: "PR 分层评审", scope: "project" as const };

  it("zh：要提炼而不是照抄、带上填好的名字与说明、要求回传 run_id；不带脚本", () => {
    const text = buildWorkflowSaveRequestPrompt({
      ...base,
      locale: "zh-CN",
      name: "pr-review",
      description: "三层评审",
    });
    expect(text).toContain("「PR 分层评审」");
    expect(text).toContain("提炼");
    expect(text).toContain("保存到本项目");
    expect(text).toContain("`pr-review`");
    expect(text).toContain("三层评审");
    expect(text).toContain('run_id: "dwfrun-7"');
    expect(text).not.toContain("agent(");
  });

  it("en：全局档写明 scope；名字空着就请模型来起，说明空着就不提", () => {
    const text = buildWorkflowSaveRequestPrompt({
      ...base,
      locale: "en-US",
      scope: "global",
      name: "  ",
      description: "",
    });
    expect(text).toContain('scope: "global"');
    expect(text).toContain("Pick the name yourself");
    expect(text).not.toContain("For the description");
    expect(text).toContain('run_id: "dwfrun-7"');
  });
});

function saveRow(
  rowId: number,
  input: Record<string, unknown>,
  status: "success" | "error" | "running" = "success",
): ConversationRow {
  return {
    rowId,
    kind: "toolCall",
    toolCallId: `save-${rowId}`,
    toolName: "SaveWorkflow",
    status,
    inputText: "",
    input,
  } as unknown as ConversationRow;
}

describe("buildWorkflowSaveCandidatesByRunId", () => {
  it("只认成功、且认领了 run_id 的 SaveWorkflow 行；同名只留一个；scope 只收两档", () => {
    const table = buildWorkflowSaveCandidatesByRunId([
      saveRow(1, { run_id: "r1", name: "a", scope: "project" }),
      saveRow(2, { run_id: "r1", name: "a", scope: "global" }),
      saveRow(3, { run_id: "r1", name: "b", scope: "user" }),
      saveRow(4, { run_id: "r2", name: "c" }, "error"),
      saveRow(5, { name: "unclaimed" }),
      saveRow(6, { run_id: "r3", name: "  " }),
    ]);
    expect(table.get("r1")).toEqual([{ name: "a", scope: "project" }, { name: "b" }]);
    expect(table.has("r2")).toBe(false);
    expect(table.has("r3")).toBe(false);
    expect(table.size).toBe(1);
  });

  it("守住协议的候选上界：超出部分留最早的那几个", () => {
    const rows = Array.from({ length: ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES + 2 }, (_, i) =>
      saveRow(i + 1, { run_id: "r", name: `w${i}` }),
    );
    const list = buildWorkflowSaveCandidatesByRunId(rows).get("r") ?? [];
    expect(list).toHaveLength(ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES);
    expect(list[0]?.name).toBe("w0");
  });
});

describe("「再次运行」实参预填", () => {
  it("这次 run 跑过的值优先于默认值；声明里没有的键不长出字段", () => {
    const fields = buildSavedWorkflowArgFields(
      {
        base: { type: "string", default: "main" },
        depth: { type: "number" },
        strict: { type: "boolean", default: false },
      },
      { base: "release/3.14", strict: true, stray: "x" },
    );
    expect(fields.map((field) => [field.name, field.value])).toEqual([
      ["base", "release/3.14"],
      ["depth", ""],
      ["strict", "true"],
    ]);
  });
});

describe("workflowRunSavedStore", () => {
  const key = workflowRunSavedKey("/repo", "r", [{ name: "a", scope: "project" }]);

  it("候选签名进键：对话里刚存过一次就是另一个问题", () => {
    expect(key).not.toBe(workflowRunSavedKey("/repo", "r", undefined));
    expect(workflowRunSavedKey("/repo", "r", [])).toBe(
      workflowRunSavedKey("/repo", "r", undefined),
    );
  });

  it("查询结果落进缓存；同一键的并发加载只发一次", async () => {
    const entry = { name: "a", description: "d", scope: "project" as const, path: "/p" };
    const loader = vi.fn(async () => ({ entry, match: "candidate" as const, runArgs: { x: 1 } }));
    const store = useWorkflowRunSavedStore.getState();
    await Promise.all([store.load(key, loader), store.load(key, loader)]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(selectWorkflowRunSavedState(useWorkflowRunSavedStore.getState(), key)).toEqual({
      status: "ready",
      entry,
      match: "candidate",
      runArgs: { x: 1 },
    });
  });

  it("老 agent（-32601）是能力缺席不是错误；其余失败记 error", async () => {
    const store = useWorkflowRunSavedStore.getState();
    await store.load(key, async () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    });
    expect(selectWorkflowRunSavedState(useWorkflowRunSavedStore.getState(), key)?.status).toBe(
      "unsupported",
    );
    const other = workflowRunSavedKey("/repo", "r2", undefined);
    await store.load(other, async () => {
      throw new Error("boom");
    });
    expect(selectWorkflowRunSavedState(useWorkflowRunSavedStore.getState(), other)?.status).toBe(
      "error",
    );
  });

  it("已有结论就不再问：候选表重建（新数组、同内容）不该让每张卡每一拍都发一次 RPC", async () => {
    const loader = vi.fn(async () => ({}));
    const store = useWorkflowRunSavedStore.getState();
    await store.load(key, loader);
    await store.load(key, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    store.invalidate();
    await useWorkflowRunSavedStore.getState().load(key, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("applySaved：这张卡立刻翻面并留着已查到的实参、不再重查；别的卡作废重查", async () => {
    const store = useWorkflowRunSavedStore.getState();
    const other = workflowRunSavedKey("/repo", "r-other", undefined);
    await store.load(key, async () => ({ runArgs: { base: "main" } }));
    await store.load(other, async () => ({}));
    const before = useWorkflowRunSavedStore.getState().generation;

    const entry = { name: "a", description: "d", scope: "global" as const, path: "/g" };
    store.applySaved(key, entry);
    const after = useWorkflowRunSavedStore.getState();
    expect(after.generation).toBe(before + 1);
    expect(selectWorkflowRunSavedState(after, key)).toEqual({
      status: "ready",
      entry,
      runArgs: { base: "main" },
    });
    expect(selectWorkflowRunSavedState(after, other)).toBeUndefined();

    const loader = vi.fn(async () => ({}));
    await after.load(key, loader);
    expect(loader).not.toHaveBeenCalled();
  });

  it("飞行途中被作废：迟到的回答不写回（那是作废之前的事实）", async () => {
    let resolve: (value: object) => void = () => {};
    const pending = useWorkflowRunSavedStore
      .getState()
      .load(key, () => new Promise((done) => (resolve = done)));
    useWorkflowRunSavedStore.getState().invalidate();
    resolve({ entry: { name: "gone", description: "d", scope: "project", path: "/p" } });
    await pending;
    expect(selectWorkflowRunSavedState(useWorkflowRunSavedStore.getState(), key)).toBeUndefined();
  });

  it("invalidate 清表并递增代", () => {
    useWorkflowRunSavedStore.getState().applySaved(key, {
      name: "a",
      description: "d",
      scope: "project",
      path: "/p",
    });
    const before = useWorkflowRunSavedStore.getState().generation;
    useWorkflowRunSavedStore.getState().invalidate();
    const after = useWorkflowRunSavedStore.getState();
    expect(after.generation).toBe(before + 1);
    expect(after.byKey).toEqual({});
  });
});

describe("词条", () => {
  it("两种语言的 saveRun 词条一一对应", () => {
    const keysOf = (locale: Record<string, string>) =>
      Object.keys(locale)
        .filter((id) => id.startsWith("chat.toolCall.workflow.saveRun."))
        .sort();
    const zh = keysOf(zhCN as Record<string, string>);
    expect(zh.length).toBeGreaterThan(0);
    expect(keysOf(enUS as Record<string, string>)).toEqual(zh);
    // 设计里定下的那两句逐字。
    expect((zhCN as Record<string, string>)["chat.toolCall.workflow.saveRun.lead"]).toBe(
      "让 ZCode 帮我提炼保存",
    );
    expect((zhCN as Record<string, string>)["chat.toolCall.workflow.saveRun.lead.hint"]).toBe(
      "ZCode 会帮你提炼出可复用的工作流，再交你确认。",
    );
  });
});
