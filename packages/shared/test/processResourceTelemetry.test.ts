import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ARMS_CUSTOM_EVENT_PROPERTY_LIMIT,
  PERF_PROCESS_WINDOW_PROPERTY_KEYS,
  PERF_SYSTEM_WINDOW_PROPERTY_KEYS,
  PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS,
  PROCESS_RESOURCE_CLI_LANES,
  PROCESS_RESOURCE_EVENT_NAMES,
  PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN,
  PROCESS_RESOURCE_ROLES,
  checkProcessResourceEventProperties,
  resolveCliProcessResourceRole,
} from "@zcode/shared";

describe("processResourceTelemetry 事件契约", () => {
  it("角色枚举覆盖 spec 第一期 10 个角色", () => {
    expect([...PROCESS_RESOURCE_ROLES]).toEqual([
      "main",
      "renderer_main",
      "renderer_guest",
      "gpu",
      "chromium_other",
      "host",
      "scheduler",
      "cli_chat",
      "cli_aux",
      "mcp",
    ]);
  });

  it("三个事件名固定，不复用旧事件名", () => {
    expect(PROCESS_RESOURCE_EVENT_NAMES).toEqual({
      processWindow: "perf_process_window",
      systemWindow: "perf_system_window",
      toolExecResource: "perf_tool_exec_resource",
    });
  });

  it("CLI 泳道词表覆盖三条 lane，chat 归 cli_chat、其余归 cli_aux", () => {
    expect([...PROCESS_RESOURCE_CLI_LANES]).toEqual(["chat", "plugin", "mcp-status"]);
    expect(resolveCliProcessResourceRole("chat")).toBe("cli_chat");
    expect(resolveCliProcessResourceRole("plugin")).toBe("cli_aux");
    expect(resolveCliProcessResourceRole("mcp-status")).toBe("cli_aux");
    // 无 lane 只可能来自版本落后的远端 server：远端 workspace 上产生持续资源占用的是 chat lane。
    expect(resolveCliProcessResourceRole(undefined)).toBe("cli_chat");
  });

  it("属性 key 白名单条数与 spec 事件契约一致", () => {
    // spec：Node 角色 20（含 heap 两项）、mcp 19（含 mcp_id 无 heap）、gpu 18。
    expect(PERF_PROCESS_WINDOW_PROPERTY_KEYS).toHaveLength(21);
    expect(PERF_SYSTEM_WINDOW_PROPERTY_KEYS).toHaveLength(17);
    expect(PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS).toHaveLength(12);
    expect(ARMS_CUSTOM_EVENT_PROPERTY_LIMIT).toBe(20);
  });

  it("PRT-026 三个事件的属性 key 不含 pid / path / workspace / session / task / command 语义", () => {
    const allKeys = [
      ...PERF_PROCESS_WINDOW_PROPERTY_KEYS,
      ...PERF_SYSTEM_WINDOW_PROPERTY_KEYS,
      ...PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS,
    ];
    const leaking = allKeys.filter((key) =>
      PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN.test(key),
    );
    expect(leaking).toEqual([]);
  });

  it("PRT-026 spec 与事件字典的三个属性表逐项匹配代码白名单", async () => {
    const documents = await Promise.all(
      ["process-resource-telemetry.md", "performance-telemetry-catalog.md"].map((name) =>
        readFile(new URL(`../../../docs/monitoring/${name}`, import.meta.url), "utf8"),
      ),
    );
    const contracts = [
      ["perf_process_window", PERF_PROCESS_WINDOW_PROPERTY_KEYS],
      ["perf_system_window", PERF_SYSTEM_WINDOW_PROPERTY_KEYS],
      ["perf_tool_exec_resource", PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS],
    ] as const;
    for (const document of documents) {
      for (const [event, keys] of contracts) {
        const section = document
          .split(/^### /m)
          .find((part) => part.split("\n")[0]?.trim() === `\`${event}\``)
          ?.split(/^## /m)[0];
        expect(section, `${event} 必须有独立属性表`).toBeDefined();
        const properties = (section ?? "")
          .split("\n")
          .filter((line) => line.startsWith("|"))
          .flatMap((line) => [...(line.split("|")[2] ?? "").matchAll(/`([^`]+)`/g)])
          .map((match) => match[1]);
        // 全局四项与事件属性合并才是最终 ARMS 契约；重复列出属性同样应失败。
        expect(["platform", "app_version", "arms_env", "device_mid", ...properties].sort()).toEqual(
          [...keys].sort(),
        );
      }
    }
  });

  it("属性计数校验拒绝白名单外的 key", () => {
    const result = checkProcessResourceEventProperties("perf_process_window", {
      process_role: "main",
      workspace_path: "/Users/somebody/repo",
    });
    expect(result.unknownKeys).toEqual(["workspace_path"]);
    expect(result.ok).toBe(false);
  });

  it("CLI 样本的 instanceToken 不在任何事件的属性白名单里", () => {
    // instanceToken 只在 main 内存里用于统计进程数与最大单进程，不进 ARMS。
    for (const key of ["instanceToken", "instance_token", "lane", "cli_lane"]) {
      const result = checkProcessResourceEventProperties("perf_process_window", {
        process_role: "cli_chat",
        [key]: "x",
      });
      expect(result.unknownKeys).toEqual([key]);
      expect(result.ok).toBe(false);
    }
  });

  it("属性计数校验在超过 20 属性时失败", () => {
    const properties = Object.fromEntries(
      PERF_PROCESS_WINDOW_PROPERTY_KEYS.map((key) => [key, "1"]),
    );
    const result = checkProcessResourceEventProperties("perf_process_window", properties);
    expect(result.count).toBe(21);
    expect(result.overLimit).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("属性计数校验忽略 undefined 值，不把它们计入上限", () => {
    const result = checkProcessResourceEventProperties("perf_process_window", {
      process_role: "gpu",
      heap_used_kb_mean: undefined,
    });
    expect(result.count).toBe(1);
    expect(result.ok).toBe(true);
  });
});
