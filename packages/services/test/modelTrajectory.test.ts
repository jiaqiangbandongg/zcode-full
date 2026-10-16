import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { readModelTrajectory } from "../src/zcode-agent/modelTrajectory.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("readModelTrajectory", () => {
  it("保留字符串 TOOL 消息顶层的 toolCallId 和 toolName", async () => {
    const dataBaseDir = makeTempDir("zcode-model-trajectory-tool-result-");
    const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
    mkdirSync(debugDir, { recursive: true });
    setDataBaseDir(dataBaseDir);

    writeFileSync(
      join(debugDir, "model-io-sess_tool_result.jsonl"),
      `${JSON.stringify({
        type: "model_io",
        sessionId: "sess_tool_result",
        requestId: "req_tool_result",
        startedAt: "2026-06-03T00:00:00.000Z",
        request: {
          messages: [
            {
              role: "tool",
              toolCallId: "call_123",
              toolName: "Read",
              content: "file body",
            },
          ],
          toolNames: ["Read"],
        },
      })}\n`,
      "utf8",
    );

    expect(
      (await readModelTrajectory("sess_tool_result")).records[0]?.request.messages[0]?.parts,
    ).toEqual([
      {
        kind: "tool-result",
        toolCallId: "call_123",
        toolName: "Read",
        output: "file body",
      },
    ]);
  });

  it("保留字符串 TOOL 消息顶层的错误状态", async () => {
    const dataBaseDir = makeTempDir("zcode-model-trajectory-tool-error-");
    const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
    mkdirSync(debugDir, { recursive: true });
    setDataBaseDir(dataBaseDir);

    writeFileSync(
      join(debugDir, "model-io-sess_tool_error.jsonl"),
      `${JSON.stringify({
        type: "model_io",
        sessionId: "sess_tool_error",
        requestId: "req_tool_error",
        startedAt: "2026-06-03T00:00:00.000Z",
        request: {
          messages: [
            {
              role: "tool",
              toolCallId: "call_error",
              toolName: "open_application",
              content: "MCP tool returned an error:\nCUA_CONTROLLER_BUSY",
              isError: true,
            },
          ],
          toolNames: ["open_application"],
        },
      })}\n`,
      "utf8",
    );

    expect(
      (await readModelTrajectory("sess_tool_error")).records[0]?.request.messages[0]?.parts,
    ).toEqual([
      {
        kind: "tool-result",
        toolCallId: "call_error",
        toolName: "open_application",
        output: {
          type: "error-text",
          value: "MCP tool returned an error:\nCUA_CONTROLLER_BUSY",
        },
      },
    ]);
  });

  it("还原同一 session 文件里的 model-io delta 请求消息", async () => {
    const dataBaseDir = makeTempDir("zcode-model-trajectory-");
    const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
    mkdirSync(debugDir, { recursive: true });
    setDataBaseDir(dataBaseDir);

    writeFileSync(
      join(debugDir, "model-io-sess_delta.jsonl"),
      [
        {
          type: "model_io",
          sessionId: "sess_delta",
          requestId: "req_1",
          startedAt: "2026-06-03T00:00:00.000Z",
          request: {
            messagesKind: "full",
            messageOffset: 0,
            messageCount: 1,
            messages: [{ role: "user", content: "first" }],
            toolNames: [],
          },
        },
        {
          type: "model_io",
          sessionId: "sess_delta",
          requestId: "req_2",
          startedAt: "2026-06-03T00:00:01.000Z",
          request: {
            messagesKind: "delta",
            messageOffset: 1,
            messageCount: 3,
            messages: [
              { role: "assistant", content: "second" },
              { role: "user", content: "third" },
            ],
            toolNames: [],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      "utf8",
    );

    const trajectory = await readModelTrajectory("sess_delta");

    expect(trajectory.records).toHaveLength(2);
    expect(trajectory.sourceFiles).toHaveLength(1);
    expect(trajectory.records[1]?.request.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(trajectory.records[1]?.request.messages[2]?.parts).toEqual([
      { kind: "text", text: "third" },
    ]);
  });

  it("从 tail baseline 继续还原后续 model-io delta 请求消息", async () => {
    const dataBaseDir = makeTempDir("zcode-model-trajectory-tail-");
    const debugDir = join(dataBaseDir, ".zcode", "cli", "rollout");
    mkdirSync(debugDir, { recursive: true });
    setDataBaseDir(dataBaseDir);

    writeFileSync(
      join(debugDir, "model-io-sess_tail_restore.jsonl"),
      [
        {
          type: "model_io",
          sessionId: "sess_tail_restore",
          requestId: "req_tail",
          startedAt: "2026-06-03T00:00:00.000Z",
          request: {
            messagesKind: "tail",
            messageOffset: 6,
            messageCount: 70,
            messages: [
              { role: "user", content: "recent-68" },
              { role: "assistant", content: "recent-69" },
            ],
            toolNames: [],
          },
        },
        {
          type: "model_io",
          sessionId: "sess_tail_restore",
          requestId: "req_delta",
          startedAt: "2026-06-03T00:00:01.000Z",
          request: {
            messagesKind: "delta",
            messageOffset: 70,
            messageCount: 71,
            messages: [{ role: "user", content: "new-70" }],
            toolNames: [],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      "utf8",
    );

    const trajectory = await readModelTrajectory("sess_tail_restore");

    expect(trajectory.records).toHaveLength(2);
    expect(trajectory.records[0]?.request.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(trajectory.records[1]?.request.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(trajectory.records[1]?.request.messages[2]?.parts).toEqual([
      { kind: "text", text: "new-70" },
    ]);
  });

  it("异步读取超过旧体积阈值的长 session model-io 文件", async () => {
    const dataBaseDir = makeTempDir("zcode-model-trajectory-large-");
    const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
    mkdirSync(debugDir, { recursive: true });
    setDataBaseDir(dataBaseDir);

    const legacyThresholdBytes = 16 * 1024 * 1024;
    writeFileSync(
      join(debugDir, "model-io-sess_large.jsonl"),
      `${JSON.stringify({
        type: "model_io",
        sessionId: "sess_large",
        requestId: "req_large",
        startedAt: "2026-06-03T00:00:00.000Z",
        request: {
          messages: [{ role: "user", content: "large session" }],
          toolNames: [],
        },
        padding: "x".repeat(legacyThresholdBytes),
      })}\n`,
      "utf8",
    );

    const readPromise = readModelTrajectory("sess_large");
    expect(readPromise).toBeInstanceOf(Promise);
    const implementation = await readFile(
      join(import.meta.dirname, "../src/zcode-agent/modelTrajectory.ts"),
      "utf8",
    );
    expect(implementation).not.toContain("readFileSync");
    const trajectory = await readPromise;

    expect(trajectory.records).toHaveLength(1);
    expect(trajectory.sourceFiles).toHaveLength(1);
    expect(trajectory.records[0]?.request.messages[0]?.parts).toEqual([
      { kind: "text", text: "large session" },
    ]);
  });

  it("只扫描超大文件尾部并丢弃起点处的残行", async () => {
    const dataBaseDir = makeTempDir("zcode-model-trajectory-bounded-tail-");
    const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
    mkdirSync(debugDir, { recursive: true });
    setDataBaseDir(dataBaseDir);

    const recentRecord = {
      type: "model_io",
      sessionId: "sess_bounded_tail",
      requestId: "req_recent",
      startedAt: "2026-06-03T00:00:01.000Z",
      request: {
        messages: [{ role: "user", content: "recent" }],
        toolNames: [],
      },
    };
    writeFileSync(
      join(debugDir, "model-io-sess_bounded_tail.jsonl"),
      `${"x".repeat(33 * 1024 * 1024)}\n${JSON.stringify(recentRecord)}\n`,
      "utf8",
    );

    const trajectory = await readModelTrajectory("sess_bounded_tail");

    expect(trajectory.truncated).toBe(true);
    expect(trajectory.records.map((record) => record.requestId)).toEqual(["req_recent"]);
  });

  it("从 querySource 和旧标题 prompt 标记调用来源", async () => {
    const dataBaseDir = makeTempDir("zcode-model-trajectory-source-");
    const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
    mkdirSync(debugDir, { recursive: true });
    setDataBaseDir(dataBaseDir);

    writeFileSync(
      join(debugDir, "model-io-sess_source.jsonl"),
      [
        {
          type: "model_io",
          sessionId: "sess_source",
          requestId: "req_main",
          querySource: "main_turn",
          startedAt: "2026-06-03T00:00:00.000Z",
          model: { role: "main" },
          request: {
            messages: [{ role: "user", content: "你好" }],
            toolNames: [],
          },
        },
        {
          type: "model_io",
          sessionId: "sess_source",
          requestId: "req_title",
          startedAt: "2026-06-03T00:00:01.000Z",
          model: { role: "lite" },
          request: {
            messages: [
              {
                role: "system",
                content:
                  "Generate a concise title for this coding session.\n\nRules:\n- Return only JSON.",
              },
              { role: "user", content: "你好" },
            ],
            toolNames: [],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      "utf8",
    );

    const trajectory = await readModelTrajectory("sess_source");

    expect(trajectory.records[0]?.callSource).toEqual({
      kind: "main",
      querySource: "main_turn",
    });
    expect(trajectory.records[1]?.callSource).toEqual({
      kind: "sidecar",
      querySource: "session_title",
    });
    expect(trajectory.records[1]?.model.role).toBe("lite");
    expect(trajectory.records[1]?.request.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
  });
});
