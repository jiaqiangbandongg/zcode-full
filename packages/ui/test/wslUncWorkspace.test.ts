import { describe, expect, it } from "vitest";
import {
  isWslUncWorkspacePath,
  parseWslUncWorkspacePath,
} from "../src/lib/wslUncWorkspace.js";

describe("wslUncWorkspace", () => {
  it("parses wsl.localhost UNC workspace paths", () => {
    const parsed = parseWslUncWorkspacePath(
      String.raw`\\wsl.localhost\Ubuntu\home\user\project`,
    );

    expect(parsed).toEqual({
      distro: "Ubuntu",
      linuxPath: "/home/user/project",
      originalPath: String.raw`\\wsl.localhost\Ubuntu\home\user\project`,
    });
  });

  it("parses wsl$ UNC workspace paths", () => {
    const parsed = parseWslUncWorkspacePath(String.raw`\\wsl$\Ubuntu\home\user`);

    expect(parsed?.distro).toBe("Ubuntu");
    expect(parsed?.linuxPath).toBe("/home/user");
  });

  it("accepts forward slash separators for normalized UNC-like paths", () => {
    expect(parseWslUncWorkspacePath("//wsl.localhost/Ubuntu/home/user")?.linuxPath).toBe(
      "/home/user",
    );
  });

  it("does not match normal Windows or network paths", () => {
    expect(isWslUncWorkspacePath(String.raw`C:\repo`)).toBe(false);
    expect(isWslUncWorkspacePath(String.raw`\\server\share\repo`)).toBe(false);
  });
});
