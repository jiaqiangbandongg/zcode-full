import { describe, expect, it } from "vitest";
import { listChildProcesses } from "../src/zcode-protocol/process-child-processes.js";

describe("process/childProcesses", () => {
  it("给官方 host MCP 反查插件名，其余原样透传", () => {
    expect(
      listChildProcesses([
        { pid: 11, serverName: "node_repl", mcpSource: "builtin" },
        {
          pid: 12,
          serverName: "plugin:computer-use:computer-use",
          mcpSource: "builtin",
          pluginName: "computer-use",
        },
        { pid: 13, serverName: "plugin:acme:tools", mcpSource: "plugin", pluginName: "acme" },
        { pid: 14, serverName: "my-server", mcpSource: "custom" },
      ]),
    ).toEqual({
      processes: [
        { pid: 11, serverName: "node_repl", mcpSource: "builtin", pluginName: "browser-use" },
        {
          pid: 12,
          serverName: "plugin:computer-use:computer-use",
          mcpSource: "builtin",
          pluginName: "computer-use",
        },
        { pid: 13, serverName: "plugin:acme:tools", mcpSource: "plugin", pluginName: "acme" },
        { pid: 14, serverName: "my-server", mcpSource: "custom" },
      ],
    });
  });
});
