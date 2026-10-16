import { botsStateFileSchema } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { importLegacyBotState } from "../src/bots/storageMigration.js";

async function migrate(options: unknown) {
  const raw = {
    version: 2,
    bots: {
      bot: {
        botId: "bot",
        workspacePath: "/workspace",
        mode: "draft",
        activeTaskId: null,
        draftOptions: { provider: "glm", ...(options as object) },
        updatedAt: 1,
      },
    },
  };
  return botsStateFileSchema.parse(importLegacyBotState(raw)).bots.bot?.draftOptions;
}
describe("Bot 一次性旧身份转换", () => {
  it("官方 GLM 旧选择规范大小写，自定义同名模型不改", async () => {
    for (const providerId of ["builtin:zai-start-plan", "personal-proxy"]) {
      expect(
        (await migrate({ model: `${providerId}/glm-5.3-flash`, thoughtLevel: "high" }))
          ?.modelSelection,
      ).toEqual({
        providerId: providerId === "personal-proxy" ? providerId : "account:zai-start-plan",
        modelId: providerId === "personal-proxy" ? "glm-5.3-flash" : "GLM-5.3-Flash",
        options: { reasoningLevel: "high" },
      });
    }
  });
  it.each(["deepseek/model", "custom:deepseek:model"])("保留明确的旧身份 %s", async (model) => {
    expect((await migrate({ model, thoughtLevel: "high" }))?.modelSelection).toEqual({
      providerId: "deepseek",
      modelId: "model",
      options: { reasoningLevel: "high" },
    });
  });
  it.each(["model", "builtin:zapi/model"])("不按模型名猜供应商 %s", async (model) => {
    expect((await migrate({ model }))?.modelSelection).toBeUndefined();
  });
  it.each(["missing/model", "custom:missing:model", "glm/model"])(
    "候选没有 %s 也保留明确身份",
    async (model) => {
      const providerId = model.startsWith("glm/") ? "glm" : "missing";
      expect((await migrate({ model, thoughtLevel: "future-level" }))?.modelSelection).toEqual({
        providerId,
        modelId: "model",
        options: { reasoningLevel: "future-level" },
      });
    },
  );
  it("已有新选择不让旧字段覆盖；损坏新选择也不回读旧字段", async () => {
    const modelSelection = {
      providerId: "deepseek",
      modelId: "model",
      options: { reasoningLevel: "low" },
    };
    expect((await migrate({ modelSelection, thoughtLevel: "high" }))?.modelSelection).toEqual(
      modelSelection,
    );
    expect(
      (await migrate({ modelSelection: null, model: "deepseek/model", thoughtLevel: "high" }))
        ?.modelSelection,
    ).toBeUndefined();
  });
  it("旧 Coding Plan 固定迁为 Individual，当前连接和候选均不参与", async () => {
    const options = { model: "builtin:bigmodel-coding-plan/GLM", thoughtLevel: "high" };
    expect((await migrate(options))?.modelSelection?.providerId).toBe(
      "account:bigmodel-individual-coding-plan",
    );
    expect(
      (
        await migrate({
          modelSelection: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM" },
        })
      )?.modelSelection?.providerId,
    ).toBe("account:bigmodel-individual-coding-plan");
  });
});
