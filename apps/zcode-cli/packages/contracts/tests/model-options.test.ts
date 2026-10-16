import { describe, expect, it } from "vitest";
import type { LimitOptionSpec } from "../src/model/model.js";

describe("LimitOptionSpec", () => {
  it("describes only the hard maximum", () => {
    const spec: LimitOptionSpec = { max: 8_000 };
    expect(spec).toEqual({ max: 8_000 });
  });
});
