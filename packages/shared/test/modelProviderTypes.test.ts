import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isBuiltinModelProviderId,
} from "../src/model-provider-types.js";

describe("model provider identities", () => {
  it("不再把已退出产品的 ZAPI 识别为 Built-in Provider", () => {
    expect(Object.values(BUILTIN_MODEL_PROVIDER_IDS)).not.toContain("builtin:zapi");
    expect(isBuiltinModelProviderId("builtin:zapi")).toBe(false);
  });
});
