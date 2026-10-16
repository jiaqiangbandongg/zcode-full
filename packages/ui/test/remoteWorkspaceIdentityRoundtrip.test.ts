// 构造（UI buildRemoteWorkspaceIdentity）↔ 解析（shared parseRemoteWorkspaceIdentity）
// 的对偶契约测试：格式一旦漂移（任一侧改动），此处红——防止两侧手写规则分叉
// （Workspace Identity 约束：构造与解析必须复用统一工具）。
import { describe, expect, it } from "vitest";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { buildRemoteWorkspaceIdentity } from "@/lib/remoteWorkspaceHistory.js";

describe("远程 workspace identity 构造↔解析对偶", () => {
  it("ssh：build → parse 还原 workspacePath", () => {
    const identity = buildRemoteWorkspaceIdentity("/srv/app/", {
      kind: "ssh",
      host: "Dev.Example.com",
      port: 2222,
      username: "root",
    });
    expect(parseRemoteWorkspaceIdentity(identity)).toEqual({
      kind: "ssh",
      // 构造侧归一：收尾斜杠清理
      workspacePath: "/srv/app",
    });
  });

  it("ssh 缺省端口（22）与 wsl/docker：build → parse 还原", () => {
    const sshDefault = buildRemoteWorkspaceIdentity("/home/dev", {
      kind: "ssh",
      host: "h",
      username: "u",
    });
    expect(parseRemoteWorkspaceIdentity(sshDefault)?.workspacePath).toBe(
      "/home/dev",
    );

    const wsl = buildRemoteWorkspaceIdentity("/mnt/c/ws", {
      kind: "wsl",
      distro: "Ubuntu-22.04",
    });
    expect(parseRemoteWorkspaceIdentity(wsl)).toEqual({
      kind: "wsl",
      workspacePath: "/mnt/c/ws",
    });

    const docker = buildRemoteWorkspaceIdentity("/workspace", {
      kind: "docker",
      container: "my-container",
    });
    expect(parseRemoteWorkspaceIdentity(docker)).toEqual({
      kind: "docker",
      workspacePath: "/workspace",
    });
  });

  it("wsl 显式 user：build → parse 不把 user 混入 workspacePath", () => {
    const identity = buildRemoteWorkspaceIdentity("/home/dev/ws", {
      kind: "wsl",
      distro: "Ubuntu-24.04",
      user: "dev",
    });

    expect(identity).toBe("remote:wsl:Ubuntu-24.04:dev:/home/dev/ws");
    expect(parseRemoteWorkspaceIdentity(identity)).toEqual({
      kind: "wsl",
      workspacePath: "/home/dev/ws",
    });
  });

  it("反斜杠路径构造侧归一为 posix，解析可还原", () => {
    const identity = buildRemoteWorkspaceIdentity("\\srv\\app", {
      kind: "docker",
      container: "c1",
    });
    expect(parseRemoteWorkspaceIdentity(identity)?.workspacePath).toBe(
      "/srv/app",
    );
  });
});
