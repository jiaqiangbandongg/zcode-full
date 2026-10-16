import { describe, expect, it } from "vitest";
import { shouldShowRemoteConnectionEntry } from "../src/hooks/useRemoteConnectionEntryVisibility.js";

describe("shouldShowRemoteConnectionEntry", () => {
  it("test 环境始终返回 true", () => {
    expect(
      shouldShowRemoteConnectionEntry({
        env: "test",
        isIntranet: false,
      }),
    ).toBe(true);
  });

  it("生产态命中内网时返回 true", () => {
    expect(
      shouldShowRemoteConnectionEntry({
        env: "production",
        isIntranet: true,
      }),
    ).toBe(true);
  });

  it("生产态且非内网时也返回 true", () => {
    expect(
      shouldShowRemoteConnectionEntry({
        env: "production",
        isIntranet: false,
      }),
    ).toBe(true);
  });
});
