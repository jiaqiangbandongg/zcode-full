import { describe, expect, it, vi } from "vitest";
import { logger } from "@/logger.js";
import {
  captureComposerRecentSubmission,
  readComposerRecent,
  resolveDraftInitialModelSelection,
} from "@/lib/composerRecent.js";

vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    values,
  };
}

const selection = { providerId: "provider", modelId: "model", options: { reasoningLevel: "high" } };
const key = "zcode-model-selection-recent-v1:/repo";

describe("composerRecent", () => {
  it("沿用旧 key 读取纯 ModelSelection，不臆造旧记录的模式", () => {
    const target = storage();
    target.values.set(key, JSON.stringify(selection));
    expect(readComposerRecent("/repo", undefined, target)).toEqual({ modelSelection: selection });
    expect(target.setItem).not.toHaveBeenCalled();
  });

  it.each([
    [JSON.stringify({ modelSelection: selection, mode: "invalid" }), { modelSelection: selection }],
    [JSON.stringify({ modelSelection: { bad: true }, mode: "yolo" }), { mode: "yolo" }],
    [JSON.stringify({ mode: "plan" }), { mode: "plan" }],
    [
      JSON.stringify({
        providerId: "provider",
        modelId: "model",
        options: { maxOutputTokens: 4096 },
      }),
      null,
    ],
    ["{}", null],
    ["null", null],
    ["broken", null],
  ])("独立校验模型与模式：%s", (raw, expected) => {
    const target = storage();
    target.values.set(key, raw);
    expect(readComposerRecent("/repo", undefined, target)).toEqual(expected);
  });

  it("接受后一次写入冻结的模型与模式，未接纳候选不改变 Recent", () => {
    const target = storage();
    const submission = { modelSelection: { ...selection, options: {} }, mode: "yolo" as const };
    const accept = captureComposerRecentSubmission("/repo", submission, undefined, target);
    expect(readComposerRecent("/repo", undefined, target)).toBeNull();
    submission.modelSelection.modelId = "edited-after-submit";
    accept();
    accept();
    expect(target.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(target.values.get(key)!)).toEqual({
      modelSelection: { providerId: "provider", modelId: "model" },
      mode: "yolo",
    });
    captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
    );
    expect(readComposerRecent("/repo", undefined, target)?.mode).toBe("yolo");
  });

  it("迟到的旧 accepted 不覆盖较新已接纳提交；较新失败不阻断较旧成功", () => {
    const target = storage();
    const older = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "yolo" },
      undefined,
      target,
    );
    const newer = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "plan" },
      undefined,
      target,
    );
    newer();
    older();
    expect(readComposerRecent("/repo", undefined, target)?.mode).toBe("plan");
    const accepted = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "edit" },
      undefined,
      target,
    );
    captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
    );
    accepted();
    expect(readComposerRecent("/repo", undefined, target)?.mode).toBe("edit");
  });

  it("指向加速卡 Provider 的提交不写入 Recent，保留上一次合法记录（spec §5.1）", () => {
    const target = storage();
    captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
    )();
    const accelerated = captureComposerRecentSubmission(
      "/repo",
      {
        modelSelection: { providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" },
        mode: "build",
      },
      undefined,
      target,
    );
    accelerated();
    expect(JSON.parse(target.values.get(key)!)).toEqual({
      modelSelection: selection,
      mode: "build",
    });
  });

  it("读取自愈：指向加速卡 Provider 的存量模型叶子被丢弃，mode 保留（spec §5.1）", () => {
    const target = storage();
    target.values.set(
      key,
      JSON.stringify({
        modelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
        mode: "yolo",
      }),
    );
    expect(readComposerRecent("/repo", undefined, target)).toEqual({ mode: "yolo" });
    // 旧版纯 ModelSelection 格式同样丢弃，避免新草稿种子指向隐藏加速身份。
    target.values.set(
      key,
      JSON.stringify({ providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" }),
    );
    expect(readComposerRecent("/repo", undefined, target)).toBeNull();
  });

  it("本地路径与同路径不同远端分别保存，空 identity 使用本地路径", () => {
    const target = storage();
    const local = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      " ",
      target,
    );
    const remoteA = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "yolo" },
      " ssh://a/repo ",
      target,
    );
    const remoteB = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "plan" },
      "ssh://b/repo",
      target,
    );
    remoteB();
    remoteA();
    local();
    expect(readComposerRecent("/repo", undefined, target)?.mode).toBe("build");
    expect(readComposerRecent("/repo", "ssh://a/repo", target)?.mode).toBe("yolo");
    expect(readComposerRecent("/repo", "ssh://b/repo", target)?.mode).toBe("plan");
    expect(readComposerRecent("/elsewhere", undefined, target)).toBeNull();
  });

  it("存储不可用或写入失败不抛给已接纳发送", () => {
    const failure = new Error("quota exceeded");
    const target = {
      getItem: () => {
        throw failure;
      },
      setItem: () => {
        throw failure;
      },
    };
    expect(readComposerRecent("/repo", undefined, target)).toBeNull();
    const accept = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "yolo" },
      undefined,
      target,
    );
    expect(accept).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ComposerRecent"),
      expect.objectContaining({ error: failure }),
    );
    expect(
      captureComposerRecentSubmission(
        "/repo",
        { modelSelection: selection, mode: "yolo" },
        undefined,
        null,
      ),
    ).not.toThrow();
  });

  it("非法提交配置不阻断发送侧的 Recent 捕获", () => {
    vi.clearAllMocks();
    const target = storage();
    const invalidMode = {
      modelSelection: selection,
      mode: "invalid",
    } as never;
    const invalidModel = {
      modelSelection: null,
      mode: "yolo",
    } as never;

    expect(() =>
      captureComposerRecentSubmission("/repo", invalidMode, undefined, target),
    ).not.toThrow();
    expect(() =>
      captureComposerRecentSubmission("/repo", invalidModel, undefined, target),
    ).not.toThrow();
    expect(target.setItem).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("失效 Model 清空；失效 Reasoning 保留模型并清空档位", () => {
    const view = {
      revision: 1,
      preferredSelection: {
        providerId: "provider",
        modelId: "model-b",
        options: { reasoningLevel: "high" },
      },
      providers: [
        {
          providerId: "provider",
          config: {},
          models: [
            {
              modelId: "model-a",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
            },
            {
              modelId: "model-b",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
            },
          ],
        },
      ],
    } as const;
    expect(
      resolveDraftInitialModelSelection(view, {
        providerId: "removed",
        modelId: "removed",
      }),
    ).toEqual({ selection: null, invalidated: true });
    expect(
      resolveDraftInitialModelSelection(view, {
        providerId: "provider",
        modelId: "model-a",
        options: { reasoningLevel: "removed" },
      }),
    ).toEqual({ selection: { providerId: "provider", modelId: "model-a" }, invalidated: true });
    expect(
      resolveDraftInitialModelSelection({ ...view, preferredSelection: undefined }, null),
    ).toEqual({ selection: null, invalidated: false });
  });
});
