import { describe, expect, it } from "vitest";
import { modelTextRequestJsonSchema } from "../src/model/index.js";

// docs/dynamic-workflow/concurrency.md「One ticket per request attempt」：准入端口是 runtime-only 请求字段；票据同时是
// 该次尝试的状态事件汇（extends ModelStatusSink）。
describe("ModelRequestAdmission", () => {
  it("is a runtime-only request field and stays out of the model request JSON schema", () => {
    const properties = (modelTextRequestJsonSchema as { properties: Record<string, unknown> })
      .properties;
    expect(properties).not.toHaveProperty("modelRequestAdmission");
  });
});
