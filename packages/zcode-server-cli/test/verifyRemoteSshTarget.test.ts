import { describe, expect, it } from "vitest";
import { dockerPlatformForTarget, resolveVerificationTarget } from "../scripts/verify-remote-ssh-target.mjs";

describe("remote SSH verification target", () => {
  it("follows the host architecture when no target is provided", () => {
    expect(resolveVerificationTarget(undefined, "x64")).toBe("linux-x64");
    expect(resolveVerificationTarget(undefined, "arm64")).toBe("linux-arm64");
  });

  it("rejects unsupported host and Darwin targets", () => {
    expect(() => resolveVerificationTarget(undefined, "ia32")).toThrow(/Unsupported host architecture/);
    expect(() => resolveVerificationTarget("darwin-arm64", "arm64")).toThrow(/Linux target/);
  });

  it("maps a release target to its Docker platform", () => {
    expect(dockerPlatformForTarget("linux-x64")).toBe("linux/amd64");
    expect(dockerPlatformForTarget("linux-arm64")).toBe("linux/arm64");
  });
});
