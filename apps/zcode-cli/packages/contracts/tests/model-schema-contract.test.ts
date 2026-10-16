import { describe, expectTypeOf, it } from "vitest";
import type {
  ModelInputFormatData,
  ModelOutputFormatData,
  ModelPropertiesData,
  EnumOptionSpecData,
  LimitOptionSpecData,
  ModelOptionSpecsData,
} from "@zcode/shared/model-config";
import type {
  ModelInputFormat,
  ModelOutputFormat,
  ModelProperties,
  EnumOptionSpec,
  LimitOptionSpec,
  ModelOptionSpecs,
} from "../src/model/model.js";

describe("CLI 与共享 Model Schema 的数据合同", () => {
  it("所有模型数据类型双向一致，不在 CLI 维护平行字段列表", () => {
    expectTypeOf<ModelInputFormat>().toEqualTypeOf<ModelInputFormatData>();
    expectTypeOf<ModelOutputFormat>().toEqualTypeOf<ModelOutputFormatData>();
    expectTypeOf<ModelProperties>().toEqualTypeOf<ModelPropertiesData>();
    expectTypeOf<EnumOptionSpec>().toEqualTypeOf<EnumOptionSpecData>();
    expectTypeOf<LimitOptionSpec>().toEqualTypeOf<LimitOptionSpecData>();
    expectTypeOf<ModelOptionSpecs>().toEqualTypeOf<ModelOptionSpecsData>();
  });
});
