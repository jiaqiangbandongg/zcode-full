import { describe, expect, it } from "vitest";
import { resolveZCodeAgentPresentationSurface } from "../src/zcode-agent/zcodeAgentPresentationSurface.js";

describe("resolveZCodeAgentPresentationSurface", () => {
  it("从本地 Desktop Host 的 telemetry runtime surface 推导 Desktop 呈现面", () => {
    expect(
      resolveZCodeAgentPresentationSurface({
        runtimeSurface: "desktop_local_host",
      }),
    ).toBe("desktop");
  });

  it("服务端灰度关闭时不注入 Desktop 呈现面", () => {
    expect(
      resolveZCodeAgentPresentationSurface({
        runtimeSurface: "desktop_local_host",
        desktopContextPromptEnabled: false,
      }),
    ).toBeUndefined();
  });

  it("服务端灰度开启时保留 Desktop 呈现面", () => {
    expect(
      resolveZCodeAgentPresentationSurface({
        serviceAuthorityMode: "desktop-attached-remote",
        desktopContextPromptEnabled: true,
      }),
    ).toBe("desktop");
  });

  it("从 Desktop-attached remote authority 推导 Desktop 呈现面", () => {
    expect(
      resolveZCodeAgentPresentationSurface({
        serviceAuthorityMode: "desktop-attached-remote",
      }),
    ).toBe("desktop");
  });

  it("不把普通 remote runtime 或无宿主事实的 Server 推导成 Desktop", () => {
    expect(
      resolveZCodeAgentPresentationSurface({
        runtimeSurface: "remote_workspace_host",
      }),
    ).toBeUndefined();
    expect(resolveZCodeAgentPresentationSurface({})).toBeUndefined();
  });
});
