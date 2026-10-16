import { describe, expect, it } from "vitest";
import {
  completeModelPropertiesDataSchema,
  modelPropertiesDataSchema,
  completeEnumOptionSpecDataSchema,
} from "@zcode/shared/model-config";
import { zcodeModelFormatPropertiesSchema } from "../src/zcode-protocol/index.js";

describe("共享 Model 数据合同", () => {
  it("拒绝未发布的旧格式名字，不双读、不静默丢字段", () => {
    for (const key of ["input_format", "output_format"]) {
      expect(modelPropertiesDataSchema.safeParse({ [key]: {} }).success).toBe(false);
    }
    for (const key of [
      "support_text",
      "support_image",
      "support_video",
      "support_audio",
      "support_pdf",
    ]) {
      expect(modelPropertiesDataSchema.safeParse({ inputFormat: { [key]: true } }).success).toBe(
        false,
      );
    }
  });
  it("协议只投影媒体格式，直接复用同一字段 schema，不复制约束", () => {
    for (const key of ["inputFormat", "outputFormat"] as const) {
      expect(zcodeModelFormatPropertiesSchema.shape[key]).toBe(
        completeModelPropertiesDataSchema.shape[key],
      );
    }
    expect(Object.keys(zcodeModelFormatPropertiesSchema.shape)).toEqual([
      "inputFormat",
      "outputFormat",
    ]);
  });

  it("公共合同不把缺省/null补成默认能力，不放宽完整模型", () => {
    const partial = { inputFormat: { supportsImage: null } };
    expect(modelPropertiesDataSchema.parse(partial)).toEqual(partial);
    expect(completeModelPropertiesDataSchema.safeParse(partial).success).toBe(false);
    expect(modelPropertiesDataSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("共享层保留纯表达式校验，不只验证字符串类型", () => {
    expect(
      completeEnumOptionSpecDataSchema.safeParse({
        values: ["disabled", "high"],
        map: '{"reasoning_effort": reasoningLevel}',
      }).success,
    ).toBe(true);
    expect(completeEnumOptionSpecDataSchema.safeParse({ values: ["high"], map: "{" }).success).toBe(
      false,
    );
  });
});
