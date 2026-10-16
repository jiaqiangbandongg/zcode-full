import { describe, expect, it } from "vitest";
import { zcodeProtocolErrorDetailSchema } from "../src/zcode-protocol/index.js";
import { sessionErrorInfoSchema } from "../src/zcode-protocol-v4/snapshot.js";

describe("underlying error wire contract", () => {
  const fields = {
    underlyingErrorMessage: "Upstream request failed",
    underlyingErrorDetail: "Upstream instance timed out after 10000ms.",
  };

  it("retains optional details through protocol and V4 snapshot validation", () => {
    expect(
      zcodeProtocolErrorDetailSchema.parse({
        type: "ModelError",
        message: "Request failed",
        ...fields,
      }),
    ).toMatchObject(fields);
    expect(
      sessionErrorInfoSchema.parse({
        at: 1,
        code: "FAILED",
        message: "Request failed",
        recoverable: true,
        source: "provider",
        ...fields,
      }),
    ).toMatchObject(fields);
  });

  it("rejects non-string detail instead of silently stripping it", () => {
    expect(
      zcodeProtocolErrorDetailSchema.safeParse({
        type: "ModelError",
        message: "Request failed",
        underlyingErrorDetail: {},
      }).success,
    ).toBe(false);
    expect(
      sessionErrorInfoSchema.safeParse({
        at: 1,
        code: "FAILED",
        message: "Request failed",
        recoverable: true,
        source: "provider",
        underlyingErrorMessage: 123,
      }).success,
    ).toBe(false);
  });
});
