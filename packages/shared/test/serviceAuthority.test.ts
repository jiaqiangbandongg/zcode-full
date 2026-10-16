import { describe, expect, it } from "vitest";
import {
  parseServiceAuthorityMode,
  SERVICE_AUTHORITY_MODE_ENV,
} from "../src/serviceAuthority.js";

describe("service authority mode", () => {
  it("parses desktop attached remote mode from env", () => {
    expect(
      parseServiceAuthorityMode({
        [SERVICE_AUTHORITY_MODE_ENV]: "desktop-attached-remote",
      }),
    ).toEqual({
      mode: "desktop-attached-remote",
      invalidRawValue: undefined,
    });
  });

  it("falls back to legacy authority when env value is invalid", () => {
    expect(
      parseServiceAuthorityMode({
        [SERVICE_AUTHORITY_MODE_ENV]: "remote-but-not-valid",
      }),
    ).toEqual({
      mode: undefined,
      invalidRawValue: "remote-but-not-valid",
    });
  });
});
