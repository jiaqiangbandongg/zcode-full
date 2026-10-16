import { describe, expect, it } from "vitest";
import zh from "@/i18n/locales/zh-CN.js";
import en from "@/i18n/locales/en-US.js";

const expected = {
  contextWindow:
    "模型一次可处理的上下文容量，单位为 Token。ZCode 会据此管理上下文。\n请勿超过模型的实际上限。",
  maxOutputTokens: "单次模型请求允许生成的最大 Token 数。\n请勿超过模型的实际上限。",
  inputModalities:
    "设置模型能够接收的内容类型：\n\n- **文本**：接收文本内容，为必选项。\n- **图片**：接收图片内容。\n- **视频**：接收视频内容。\n- **PDF**：直接接收 PDF 文档。",
  outputModalities: "模型生成回复的内容类型。目前不支持文本以外的其他选项。",
  capabilities:
    "- **结构化输出**：支持通过 JSON Schema 约束模型输出的字段、类型和结构。\n- **原生联网搜索**：支持使用模型接口内置的联网搜索能力。\n- **对话中系统消息**：支持在对话中途插入系统指令。\n\n请勿勾选模型不支持的能力。",
  reasoningLevelsOrdered:
    "设置聊天时可选择的推理等级，**必须按推理强度从低到高排列**。\n请勿配置模型不支持的推理等级。",
  reasoningLevelMapping:
    "使用 CEL 表达式，将当前推理等级 `reasoningLevel` 映射为模型接口的请求字段。表达式返回的 JSON 对象会合并到实际发送的请求体中。",
  advanced:
    "**MFJS 工具 Schema**：启用 Moonshot Flavored JSON Schema（Moonshot 的 JSON Schema 格式）兼容处理，常用于 Moonshot 的 Kimi 模型接口。仅在模型接口要求该格式时开启。",
  followRecommendedConfig:
    "根据模型 ID、Base URL 和 API 格式，为您智能匹配推荐配置。ZCode 会持续更新推荐配置，并自动同步给您。\n如果手动修改某项配置，该项将转为手动管理，不再跟随推荐更新；其他配置仍由智能配置管理。",
};
describe("Todo125 定稿文案", () => {
  it.each(Object.entries(expected))("%s 中文逐字保持，英文对应且不加入口链接", (field, copy) => {
    const key = `settings.modelProvider.help.${field}`;
    expect(zh[key]).toBe(copy);
    expect(en[key]?.trim().length).toBeGreaterThan(20);
    expect(en[key]).not.toContain("http");
  });
  it("模型 ID 没有说明；模型编辑器重置表单与原恢复文案分别保留", () => {
    expect(zh["settings.modelProvider.help.modelId"]).toBeUndefined();
    expect(zh["settings.modelProvider.restoreConfig"]).toBe("恢复");
    expect(en["settings.modelProvider.restoreConfig"]).toBe("Restore");
    expect(zh["settings.modelProvider.resetForm"]).toBe("重置表单");
    expect(en["settings.modelProvider.resetForm"]).toBe("Reset form");
    expect(zh["settings.modelProvider.reasoningLevelsOrdered"]).toBe("推理等级（从低到高）");
    expect(en["settings.modelProvider.advancedConfig"]).toBe("Advanced settings");
  });
});
