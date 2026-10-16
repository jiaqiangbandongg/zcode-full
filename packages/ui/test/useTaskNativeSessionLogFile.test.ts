import { describe, expect, it } from "vitest";
import { supportsTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";

describe("supportsTaskNativeSessionLogFile", () => {
  it("已支持原生日志路径解析的 provider 不应在 UI 层被提前禁用", () => {
    expect(supportsTaskNativeSessionLogFile("glm")).toBe(true);
  });

  it("provider 未知时允许继续走服务层解析", () => {
    expect(supportsTaskNativeSessionLogFile(null)).toBe(true);
    expect(supportsTaskNativeSessionLogFile(undefined)).toBe(true);
  });
});
