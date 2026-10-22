import { describe, expect, it } from "vitest";
import { parseRemoteToolExecutionEvents } from "./e2e/helpers/remote-tool-execution-evidence.js";

const query = { toolCallId: "permission-write", toolName: "Write" };
const encode = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

describe("权限恢复后的真实工具执行次数", () => {
  it("覆盖同一文件两次仍保留两次执行，不能靠文件一行假通过", () => {
    const started = { event: "tool.call.started", ...query };
    const completed = { event: "tool.call.completed", context: query };
    const events = parseRemoteToolExecutionEvents(
      encode(started, completed, started, completed),
      query,
    );
    expect(events.filter((event) => event.event === "tool.call.started")).toHaveLength(2);
    expect(events.filter((event) => event.event === "tool.call.completed")).toHaveLength(2);
  });
  it("只计对应 Write 的正式执行事件，排除其他调用和权限元数据", () => {
    const events = parseRemoteToolExecutionEvents(
      encode(
        { event: "tool.permission.resolved", ...query },
        { event: "tool.call.started", ...query, toolCallId: "another-write" },
        { event: "tool.call.started", ...query, toolName: "Read" },
        { event: "tool.call.started", context: query },
        { event: "tool.call.completed", ...query },
      ),
      query,
    );
    expect(events.map((event) => event.event)).toEqual([
      "tool.call.started",
      "tool.call.completed",
    ]);
  });
  it("日志损坏不能默认为零次执行", () => {
    expect(() => parseRemoteToolExecutionEvents("broken-json", query)).toThrow();
    expect(parseRemoteToolExecutionEvents("", query)).toEqual([]);
  });
  it("同一任务换了 toolCallId 再次 Write 仍计入，其他任务不能混入", () => {
    const events = parseRemoteToolExecutionEvents(
      encode(
        { event: "tool.call.started", toolCallId: "first", toolName: "Write", sessionId: "task-a" },
        {
          event: "tool.call.started",
          toolCallId: "second",
          toolName: "Write",
          sessionId: "task-a",
        },
        { event: "tool.call.started", toolCallId: "other", toolName: "Write", sessionId: "task-b" },
      ),
      { sessionId: "task-a", toolName: "Write" },
    );
    expect(events.map((event) => event.toolCallId)).toEqual(["first", "second"]);
  });
});
