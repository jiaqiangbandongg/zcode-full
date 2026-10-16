import { describe, expect, it } from "vitest";
import {
  decodeCustomModelValue,
  encodeCustomModelValue,
} from "../src/lib/zcodeCustomModelValue.js";

describe("ZCode custom model value", () => {
  it("编码并解码 provider/model 身份", () => {
    const value = encodeCustomModelValue("provider:a", "model/b");
    expect(decodeCustomModelValue(value)).toEqual({
      providerId: "provider:a",
      modelName: "model/b",
    });
  });

  it("保留缺少 model 的历史值解析能力", () => {
    expect(decodeCustomModelValue("custom:provider-a")).toEqual({
      providerId: "provider-a",
    });
  });

  it("拒绝普通模型值", () => {
    expect(decodeCustomModelValue("glm-5")).toBeNull();
  });
});
