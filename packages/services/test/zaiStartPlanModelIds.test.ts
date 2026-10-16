import { describe, expect, it } from "vitest";
import { resolveZaiStartPlanBalanceModelIds } from "../src/model-provider/zaiStartPlanBilling.js";

describe("Start 官方成员名单", () => {
  it("规范化再去重，未知型号和服务端能力范围保持不变", () => {
    expect(
      resolveZaiStartPlanBalanceModelIds({
        data: {
          balances: [
            {
              capabilities: ["model:glm-5.3-FLASH", "MODEL:GLM-5.3-Flash", "model:future-glm"],
              show_name: "不应加入",
            },
            { show_name: "glm-4.7-flashx" },
          ],
        },
      }),
    ).toEqual(["GLM-5.3-Flash", "future-glm", "GLM-4.7-FlashX"]);
    expect(resolveZaiStartPlanBalanceModelIds({})).toEqual([]);
  });
});
