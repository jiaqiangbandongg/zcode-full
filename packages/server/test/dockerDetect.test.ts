import { describe, expect, it } from "vitest";
import { parseDockerContainerList, resolveDockerCommand } from "../src/remote/docker-detect.js";

describe("docker detect", () => {
  it("GUI PATH 未包含 docker 时应回退到 macOS 常见安装路径", () => {
    const command = resolveDockerCommand({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      homeDir: "/Users/demo",
      isExecutable: (candidate) => candidate === "/usr/local/bin/docker",
      platform: "darwin",
    });

    expect(command).toBe("/usr/local/bin/docker");
  });

  it("PATH 中已有 docker 时优先使用 PATH 中的可执行文件", () => {
    const command = resolveDockerCommand({
      env: { PATH: "/custom/bin:/usr/local/bin" },
      homeDir: "/Users/demo",
      isExecutable: (candidate) => candidate === "/custom/bin/docker",
      platform: "darwin",
    });

    expect(command).toBe("/custom/bin/docker");
  });

  it("保留 Docker JSON 行解析行为", () => {
    const containers = parseDockerContainerList(
      [
        JSON.stringify({
          ID: "931b148d01e8",
          Image: "ubuntu:24.04",
          Names: "zcode-ssh-linux-amd64",
          State: "running",
          Status: "Up 2 minutes",
        }),
        "",
      ].join("\n"),
    );

    expect(containers).toEqual([{
      id: "931b148d01e8",
      image: "ubuntu:24.04",
      name: "zcode-ssh-linux-amd64",
      state: "running",
      status: "Up 2 minutes",
    }]);
  });
});
