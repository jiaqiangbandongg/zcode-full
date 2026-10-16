import { describe, expect, it, vi } from "vitest";
import type { RemoteTarget } from "@zcode/shared";
import { pushDynamicWorkflowUserModeToRemoteHosts } from "../src/host/remoteDynamicWorkflowUserMode.js";

// DWG-21（docs/dynamic-workflow/launch.md「The user's choice」）：desktop-attached remote Host 读不到
// 桌面的设置，desktop 把用户选择推过去；standalone server 有自己的设置权威，不推。

function agent() {
  return { syncDynamicWorkflowUserMode: vi.fn(async (_params: { mode?: string }) => undefined) };
}

describe("pushDynamicWorkflowUserModeToRemoteHosts（DWG-21）", () => {
  it("推给 SSH/WSL/Docker 连接，跳过 standalone server", async () => {
    const ssh = agent();
    const docker = agent();
    const server = agent();
    const targets: Array<{ target: RemoteTarget; zcodeAgentService: ReturnType<typeof agent> }> = [
      { target: { kind: "ssh", host: "h", username: "u" }, zcodeAgentService: ssh },
      { target: { kind: "docker", container: "c" }, zcodeAgentService: docker },
      { target: { kind: "server", url: "https://s.example.com" }, zcodeAgentService: server },
    ];
    await pushDynamicWorkflowUserModeToRemoteHosts(targets, "onDemand", vi.fn());
    expect(ssh.syncDynamicWorkflowUserMode).toHaveBeenCalledWith({ mode: "onDemand" });
    expect(docker.syncDynamicWorkflowUserMode).toHaveBeenCalledWith({ mode: "onDemand" });
    expect(server.syncDynamicWorkflowUserMode).not.toHaveBeenCalled();
  });

  it("跟随服务端时推不带 mode 的信号", async () => {
    const ssh = agent();
    await pushDynamicWorkflowUserModeToRemoteHosts(
      [{ target: { kind: "ssh", host: "h", username: "u" }, zcodeAgentService: ssh }],
      undefined,
      vi.fn(),
    );
    expect(ssh.syncDynamicWorkflowUserMode).toHaveBeenCalledWith({});
  });

  it("单个远程 Host 失败（旧版本不认识方法、连接断开）只报错，不影响其它连接也不抛出", async () => {
    const broken = {
      syncDynamicWorkflowUserMode: vi.fn(async () => {
        throw new Error("Unknown command");
      }),
    };
    const ok = agent();
    const onError = vi.fn();
    await expect(
      pushDynamicWorkflowUserModeToRemoteHosts(
        [
          { target: { kind: "wsl", distro: "Ubuntu" }, zcodeAgentService: broken },
          { target: { kind: "ssh", host: "h", username: "u" }, zcodeAgentService: ok },
        ],
        "disabled",
        onError,
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(ok.syncDynamicWorkflowUserMode).toHaveBeenCalledWith({ mode: "disabled" });
  });
});
