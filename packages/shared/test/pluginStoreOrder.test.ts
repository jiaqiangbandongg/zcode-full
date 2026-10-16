import { describe, expect, it } from "vitest";
import { parsePluginStoreOrder } from "../src/pluginStoreOrder.js";

describe("parsePluginStoreOrder", () => {
  it("归一化两级列表，重复项取首次，模式互不继承", () => {
    expect(
      parsePluginStoreOrder({
        code: {
          categoryOrder: [" other ", "productivity", "other"],
          pluginOrder: { productivity: [" b@official ", "a@official", "b@official"] },
        },
      }),
    ).toEqual({
      code: {
        categoryOrder: ["other", "productivity"],
        pluginOrder: { productivity: ["b@official", "a@official"] },
      },
    });
  });

  it.each([undefined, null, false, "bad", []])("缺失/无效配置回退默认 %j", (value) => {
    expect(parsePluginStoreOrder(value)).toBeNull();
  });

  it("无效模式隔离，不影响另一模式", () => {
    expect(
      parsePluginStoreOrder({
        code: { categoryOrder: [3] },
        work: { categoryOrder: [] },
      }),
    ).toEqual({ work: { categoryOrder: [] } });
    expect(parsePluginStoreOrder({ code: { pluginOrder: { productivity: [""] } } })).toEqual({});
  });
});
