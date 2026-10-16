import { describe, expect, it, vi } from "vitest";
import { resolveAutomationSubmissionModelSelection } from "../src/host/automationModelSelection.js";

describe("resolveAutomationSubmissionModelSelection", () => {
  it("首次派发重读导入后的配置；读取失败不能落入 Workspace 默认，同 run 不重读", async () => {
    const migrated = {
      providerId: "account:bigmodel-team-coding-plan",
      modelId: "GLM-5",
      options: { reasoningLevel: "high" },
    };
    const readSelection = vi.fn().mockResolvedValue(migrated);
    const getView = vi.fn().mockResolvedValue({ effectiveSelection: migrated });
    await expect(
      resolveAutomationSubmissionModelSelection({
        readSelection,
        modelSelectionService: { getView },
      }),
    ).resolves.toEqual(migrated);
    expect(getView).toHaveBeenCalledWith({ selection: migrated });
    readSelection.mockRejectedValue(new Error("migration unavailable"));
    getView.mockClear();
    await expect(
      resolveAutomationSubmissionModelSelection({
        readSelection,
        modelSelectionService: { getView },
      }),
    ).rejects.toThrow("migration unavailable");
    expect(getView).not.toHaveBeenCalled();
    readSelection.mockClear();
    await expect(
      resolveAutomationSubmissionModelSelection({
        fixedSelection: migrated,
        readSelection,
        modelSelectionService: { getView },
      }),
    ).resolves.toEqual(migrated);
    expect(readSelection).not.toHaveBeenCalled();
  });
  it("长期配置先由目标 Host 解析为本轮有效选择，不直接固定旧账号身份", async () => {
    const selection = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    } as const;
    const effectiveSelection = { ...selection, providerId: "provider-current" };
    const getView = vi.fn().mockResolvedValue({ revision: 1, providers: [], effectiveSelection });

    await expect(
      resolveAutomationSubmissionModelSelection({ selection, modelSelectionService: { getView } }),
    ).resolves.toEqual(effectiveSelection);
    expect(getView).toHaveBeenCalledWith({ selection });
    expect(selection.providerId).toBe("provider-a");
  });

  it("同 run 已固定则不重读、不随账号切换，即使当前 Host 读取失败", async () => {
    const fixedSelection = {
      providerId: "old",
      modelId: "model",
      options: { reasoningLevel: "high" },
    };
    const getView = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      resolveAutomationSubmissionModelSelection({
        fixedSelection,
        modelSelectionService: { getView },
      }),
    ).resolves.toEqual(fixedSelection);
    expect(getView).not.toHaveBeenCalled();
  });

  it("有效选择缺模型或档位时拒绝固定，不回退 preferredSelection", async () => {
    for (const effectiveSelection of [null, { providerId: "current", modelId: "model" }]) {
      await expect(
        resolveAutomationSubmissionModelSelection({
          selection: { providerId: "old", modelId: "model" },
          modelSelectionService: {
            getView: vi.fn().mockResolvedValue({
              revision: 1,
              providers: [],
              effectiveSelection,
              preferredSelection: {
                providerId: "other",
                modelId: "other",
                options: { reasoningLevel: "high" },
              },
            }),
          },
        }),
      ).rejects.toThrow("Automation 模型选择不可用");
    }
  });

  it("跟随 Workspace 时在触发边界固定目标 Host preferredSelection", async () => {
    const preferredSelection = {
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    } as const;

    await expect(
      resolveAutomationSubmissionModelSelection({
        modelSelectionService: {
          getView: vi.fn().mockResolvedValue({
            revision: 3,
            providers: [],
            preferredSelection,
          }),
        },
      }),
    ).resolves.toEqual(preferredSelection);
  });

  it("目标 Host 没有可用首选模型时拒绝形成 Submission", async () => {
    await expect(
      resolveAutomationSubmissionModelSelection({
        modelSelectionService: {
          getView: vi.fn().mockResolvedValue({ revision: 3, providers: [] }),
        },
      }),
    ).rejects.toThrow("Automation 无法从目标 Host 解析首选模型");
  });
});
