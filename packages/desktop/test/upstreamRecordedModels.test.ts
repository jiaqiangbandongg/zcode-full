import { describe, expect, it } from "vitest";
import {
  RECORDED_UPSTREAM_MODEL,
  RECORDED_UPSTREAM_SECONDARY_MODEL,
  resolveUpstreamModels,
} from "./e2e/helpers/upstream-recorded-models.js";

describe("E2E 上游模型", () => {
  it("回放始终使用录制夹具时的模型，不受本地模型环境变量影响", () => {
    expect(
      resolveUpstreamModels({
        E2E_PROVIDER_HTTP_MODE: "replay",
        E2E_PROVIDER_MODEL: "local-model",
        E2E_PROVIDER_SECONDARY_MODEL: "local-secondary",
      }),
    ).toEqual({
      model: RECORDED_UPSTREAM_MODEL,
      secondaryModel: RECORDED_UPSTREAM_SECONDARY_MODEL,
    });
    expect(resolveUpstreamModels({ E2E_PROVIDER_MODEL: "local-model" }).model).toBe(
      RECORDED_UPSTREAM_MODEL,
    );
  });

  it("capture 模式使用环境变量指定的模型，未指定时回到录制模型", () => {
    expect(
      resolveUpstreamModels({
        E2E_PROVIDER_HTTP_MODE: "capture",
        E2E_PROVIDER_MODEL: "model-a",
      }),
    ).toEqual({ model: "model-a", secondaryModel: RECORDED_UPSTREAM_SECONDARY_MODEL });
  });
});
