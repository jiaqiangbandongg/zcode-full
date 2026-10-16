import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inspectTrace, listTraces } from "../server/analyzer.js";

describe("debug analyzer", () => {
  it("merges JSONL events and logs into trace summaries", async () => {
    const fixture = await createFixture();

    const response = await listTraces({
      eventPath: fixture.eventPath,
      logDir: fixture.logDir,
      dbPath: join(fixture.root, "missing.sqlite"),
    });

    expect(response.traces).toHaveLength(1);
    expect(response.traces[0]).toMatchObject({
      traceId: "trace-debug",
      firstUserMessage: "inspect this trace",
      eventCount: 3,
      logCount: 1,
      cacheReadTokens: 64,
      cacheWriteTokens: 12,
    });
    expect(response.sources.find((source) => source.kind === "eventlog")?.recordCount).toBe(3);
  });

  it("derives context sections and cache prefix status from observed events", async () => {
    const fixture = await createFixture();

    const detail = await inspectTrace("trace-debug", {
      eventPath: fixture.eventPath,
      logDir: fixture.logDir,
      dbPath: join(fixture.root, "missing.sqlite"),
    });

    expect(detail.timeline.map((item) => item.kind)).toContain("model_request");
    expect(detail.timeline[0]?.kind).toBe("turn_complete");
    const fullSnapshot = detail.contextSnapshots.find(
      (snapshot) => snapshot.observationLevel === "full",
    );
    expect(fullSnapshot?.sections.map((section) => section.source)).toEqual(
      expect.arrayContaining(["system_prompt", "skills", "tools"]),
    );
    expect(detail.cacheReports[0]?.segments.map((segment) => segment.status)).toEqual([
      "hit",
      "miss",
    ]);
    expect(detail.developerRequests.map((request) => request.eventName)).toContain(
      "prompt_cache_report",
    );
  });

  it("builds overlapping execution spans for Gantt views", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-spans-"));
    const logDir = join(root, "logs");
    await mkdir(logDir);
    const eventPath = join(root, "events.jsonl");
    await writeFile(join(logDir, "zcode.jsonl"), "", "utf8");
    const events = [
      {
        id: "evt-turn-start",
        type: "turn_started",
        timestamp: "2026-05-04T01:00:00.000Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
      },
      {
        id: "evt-model-start",
        type: "model_request",
        timestamp: "2026-05-04T01:00:00.100Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
        payload: { model: "gpt-test" },
      },
      {
        id: "evt-tool-read-start",
        type: "tool_call_started",
        timestamp: "2026-05-04T01:00:00.500Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
        payload: { toolCallId: "tool-read", toolName: "Read" },
      },
      {
        id: "evt-tool-bash-start",
        type: "tool_call_started",
        timestamp: "2026-05-04T01:00:00.600Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
        payload: { toolCallId: "tool-bash", toolName: "Bash" },
      },
      {
        id: "evt-tool-read-end",
        type: "tool_call_result",
        timestamp: "2026-05-04T01:00:01.500Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
        payload: { toolCallId: "tool-read", toolName: "Read" },
      },
      {
        id: "evt-tool-bash-end",
        type: "tool_call_result",
        timestamp: "2026-05-04T01:00:01.700Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
        payload: { toolCallId: "tool-bash", toolName: "Bash" },
      },
      {
        id: "evt-tool-open-start",
        type: "tool_call_started",
        timestamp: "2026-05-04T01:00:01.800Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
        payload: { toolCallId: "tool-open", toolName: "Open" },
      },
      {
        id: "evt-model-end",
        type: "model_complete",
        timestamp: "2026-05-04T01:00:02.000Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
      },
      {
        id: "evt-turn-end",
        type: "turn_complete",
        timestamp: "2026-05-04T01:00:02.200Z",
        traceId: "trace-spans",
        sessionId: "session-spans",
        turnId: "turn-1",
        payload: { resultType: "success" },
      },
    ];
    await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const detail = await inspectTrace("trace-spans", {
      eventPath,
      logDir,
      dbPath: join(root, "missing.sqlite"),
    });

    const lanes = detail.spans.map((span) => span.lane);
    expect(lanes).toEqual(expect.arrayContaining(["turn", "model", "tool"]));
    const readSpan = detail.spans.find((span) => span.toolCallId === "tool-read");
    const bashSpan = detail.spans.find((span) => span.toolCallId === "tool-bash");
    expect(readSpan).toMatchObject({
      lane: "tool",
      label: "Read",
      startAt: "2026-05-04T01:00:00.500Z",
      endAt: "2026-05-04T01:00:01.500Z",
      status: "ok",
    });
    expect(bashSpan).toMatchObject({
      lane: "tool",
      label: "Bash",
      startAt: "2026-05-04T01:00:00.600Z",
      endAt: "2026-05-04T01:00:01.700Z",
      status: "ok",
    });
    expect(new Date(readSpan?.startAt ?? 0).getTime()).toBeLessThan(
      new Date(bashSpan?.startAt ?? 0).getTime(),
    );
    expect(new Date(readSpan?.endAt ?? 0).getTime()).toBeGreaterThan(
      new Date(bashSpan?.startAt ?? 0).getTime(),
    );
    const openSpan = detail.spans.find((span) => span.toolCallId === "tool-open");
    expect(openSpan).toMatchObject({
      lane: "tool",
      label: "Open",
      status: "unknown",
    });
    expect(openSpan?.endAt).toBeUndefined();
  });

  it("uses debug context-built logs as full context snapshots when section content is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-context-log-"));
    const logDir = join(root, "logs");
    await mkdir(logDir);
    await writeFile(
      join(logDir, "zcode.jsonl"),
      `${[
        {
          timestamp: "2026-05-04T01:00:00.100Z",
          level: "debug",
          event: "context.built",
          message: "Context built",
          traceId: "trace-log-context",
          sessionId: "session-log-context",
          turnId: "turn-log-context",
          status: "completed",
          context: {
            totalChars: 54,
            totalTokens: 14,
            sections: [
              {
                name: "Skills",
                source: "skills",
                chars: 32,
                tokens: 8,
                preview: "## Skills - debug",
                content: "## Skills\n- debug: inspect things",
              },
              {
                name: "Tools",
                source: "tools",
                chars: 22,
                tokens: 6,
                preview: "## Tools",
                content: "## Tools\n- Read",
              },
            ],
          },
        },
        {
          timestamp: "2026-05-04T01:00:00.200Z",
          level: "debug",
          event: "context_usage_snapshot",
          message: "Context usage snapshot",
          traceId: "trace-log-context",
          sessionId: "session-log-context",
          turnId: "turn-log-context",
          status: "completed",
          context: {
            tokenMethod: "estimated",
            confidence: "low",
            tokenizer: "zcode.estimateTokens.v1",
            totalChars: 140,
            totalTokens: 35,
            categories: [
              {
                name: "Meta user context",
                source: "meta_user_context",
                chars: 20,
                tokens: 5,
                tokenMethod: "estimated",
                confidence: "medium",
                tokenizer: "zcode.estimateTokens.v1",
              },
              {
                name: "Skills",
                source: "skills",
                chars: 32,
                tokens: 8,
                tokenMethod: "estimated",
                confidence: "medium",
                tokenizer: "zcode.estimateTokens.v1",
              },
              {
                name: "MCP tool schemas",
                source: "mcp_tool_schemas",
                chars: 88,
                tokens: 22,
                tokenMethod: "estimated",
                confidence: "low",
                tokenizer: "zcode.estimateTokens.v1",
              },
            ],
            mcpTools: [
              {
                name: "mcp__github__search_issues",
                source: "mcp_tool",
                serverName: "github",
                chars: 88,
                tokens: 22,
                tokenMethod: "estimated",
                confidence: "low",
                tokenizer: "zcode.estimateTokens.v1",
              },
            ],
            warnings: ["当前 token 来自本地估算。"],
          },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const detail = await inspectTrace("trace-log-context", {
      logDir,
      dbPath: join(root, "missing.sqlite"),
    });

    expect(detail.contextSnapshots).toHaveLength(1);
    expect(detail.contextSnapshots[0]).toMatchObject({
      observationLevel: "full",
      sessionId: "session-log-context",
      turnId: "turn-log-context",
      warnings: [],
    });
    expect(detail.contextSnapshots[0]?.sections.map((section) => section.source)).toEqual([
      "skills",
      "tools",
    ]);
    expect(detail.contextSnapshots[0]?.sections[0]?.content).toContain("debug: inspect things");
    expect(detail.contextUsageSnapshots[0]).toMatchObject({
      tokenMethod: "estimated",
      confidence: "low",
      totalTokens: 35,
    });
    expect(detail.contextUsageSnapshots[0]?.categories.map((category) => category.source)).toEqual([
      "meta_user_context",
      "skills",
      "mcp_tool_schemas",
    ]);
    expect(detail.contextUsageSnapshots[0]?.mcpTools[0]).toMatchObject({
      name: "mcp__github__search_issues",
      serverName: "github",
      tokenMethod: "estimated",
      confidence: "low",
    });
    expect(detail.developerRequests.map((request) => request.eventName)).not.toContain(
      "context_snapshot",
    );
  });

  it("keeps timeline summaries and payloads untruncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-full-timeline-"));
    const logDir = join(root, "logs");
    await mkdir(logDir);
    const eventPath = join(root, "events.jsonl");
    const dbPath = join(root, "db.sqlite");
    const eventText = ["event-start", "e".repeat(260), "event-tail"].join("\n");
    const logText = ["log-start", "l".repeat(4_200), "log-tail"].join("\n");
    const dbText = ["db-start", "d".repeat(260), "db-tail"].join("\n");
    const partText = ["part-start", "p".repeat(260), "part-tail"].join("\n");

    await writeFile(
      eventPath,
      `${JSON.stringify({
        id: "evt-full-user",
        type: "user_message",
        timestamp: "2026-05-04T01:00:00.000Z",
        traceId: "trace-full-timeline",
        sessionId: "session-full-timeline",
        payload: { content: eventText },
      })}\n`,
      "utf8",
    );

    await writeFile(
      join(logDir, "zcode.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-05-04T01:00:00.100Z",
        level: "debug",
        event: "debug.long",
        message: "Full log payload",
        traceId: "trace-full-timeline",
        sessionId: "session-full-timeline",
        context: { detail: logText },
      })}\n`,
      "utf8",
    );

    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table session (
          id text primary key,
          project_id text not null,
          title text not null,
          directory text not null,
          time_created integer not null,
          time_updated integer not null
        );
        create table message (
          id text primary key,
          session_id text not null,
          time_created integer not null,
          time_updated integer not null,
          data text not null
        );
        create table part (
          id text primary key,
          message_id text not null,
          session_id text not null,
          time_created integer not null,
          time_updated integer not null,
          data text not null
        );
      `);
      db.prepare(
        "insert into session (id, project_id, title, directory, time_created, time_updated) values (?, ?, ?, ?, ?, ?)",
      ).run("session-full-timeline", "project-full", "Full", "/work/full", 1000, 1000);
      db.prepare(
        "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      ).run(
        "message-full",
        "session-full-timeline",
        1100,
        1100,
        JSON.stringify({ role: "user", content: dbText }),
      );
      db.prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      ).run(
        "part-full",
        "message-full",
        "session-full-timeline",
        1200,
        1200,
        JSON.stringify({ type: "text", text: partText }),
      );
    } finally {
      db.close();
    }

    const detail = await inspectTrace("trace-full-timeline", {
      eventPath,
      logDir,
      dbPath,
    });
    const eventItem = detail.timeline.find((item) => item.id === "event:evt-full-user");
    const logItem = detail.timeline.find((item) => item.kind === "debug.long");
    const dbMessage = detail.timeline.find((item) => item.id === "sqlite:message:message-full");
    const dbPart = detail.timeline.find((item) => item.id === "sqlite:part:part-full");

    expect(eventItem?.summary).toContain("event-tail");
    expect(eventItem?.summary).not.toContain("...");
    expect((eventItem?.payload as { content?: string } | undefined)?.content).toBe(eventText);
    expect((logItem?.payload as { detail?: string } | undefined)?.detail).toBe(logText);
    expect(dbMessage?.summary).toContain("db-tail");
    expect(dbMessage?.summary).not.toContain("...");
    expect(dbPart?.summary).toContain("part-tail");
    expect(dbPart?.summary).not.toContain("...");
  });

  it("surfaces JSONL parse warnings without failing the whole source", async () => {
    const fixture = await createFixture({ includeBadLine: true });

    const response = await listTraces({
      eventPath: fixture.eventPath,
      logDir: fixture.logDir,
      dbPath: join(fixture.root, "missing.sqlite"),
    });

    expect(response.sources.find((source) => source.kind === "eventlog")?.warning).toContain(
      "不是合法 JSON",
    );
    expect(response.traces[0]?.traceId).toBe("trace-debug");
  });

  it("lists projects, filters traces by project, and defaults trace list to 10 items", async () => {
    const fixture = await createProjectFixture();

    const all = await listTraces({
      eventPath: fixture.eventPath,
      logDir: fixture.logDir,
      dbPath: fixture.dbPath,
    });

    expect(all.projects.map((project) => project.projectId)).toEqual(["project-new", "project-old"]);
    expect(all.traces).toHaveLength(10);

    const filtered = await listTraces({
      eventPath: fixture.eventPath,
      logDir: fixture.logDir,
      dbPath: fixture.dbPath,
      projectId: "project-old",
    });

    expect(filtered.traces.map((trace) => trace.traceId)).toEqual(["trace-old"]);
    expect(filtered.traces[0]?.firstUserMessage).toBe("old project part prompt");

    const detail = await inspectTrace("trace-old", {
      eventPath: fixture.eventPath,
      logDir: fixture.logDir,
      dbPath: fixture.dbPath,
    });
    expect(detail.cacheReports[0]).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      hitRate: 0.2,
    });
    expect(detail.cacheReports[0]?.segments).toEqual([]);
    expect(detail.cacheReports[0]?.limitations[0]).toBe("SQLite 里有聚合缓存 token，但没有逐文本 cache report。");
    expect(detail.contextUsageSnapshots[0]).toMatchObject({
      totalTokens: 100,
      tokenMethod: "provider_usage",
      confidence: "low",
    });
    expect(detail.contextUsageSnapshots[0]?.categories[0]).toMatchObject({
      name: "模型输入（SQLite 聚合）",
      source: "other",
      tokens: 100,
    });
    expect(detail.contextUsageSnapshots[0]?.warnings[0]).toContain("无法拆分");
  });
});

async function createFixture(options: { includeBadLine?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-debug-"));
  const logDir = join(root, "logs");
  await mkdir(logDir);
  const eventPath = join(root, "events.jsonl");
  const logPath = join(logDir, "zcode.jsonl");
  const systemPrompt = [
    "You are ZCode.",
    "",
    "## Skills",
    "- debug: inspect things",
    "",
    "## Available Tools",
    "### Read",
    "Read files",
    "",
    "# User Instructions",
    "Keep work observable.",
  ].join("\n");

  const events = [
    {
      id: "evt-1",
      type: "model_request",
      timestamp: "2026-05-04T01:00:00.000Z",
      traceId: "trace-debug",
      sessionId: "session-debug",
      turnId: "turn-1",
      payload: {
        model: "gpt-test",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "inspect this trace" },
        ],
      },
    },
    {
      id: "evt-2",
      type: "model_complete",
      timestamp: "2026-05-04T01:00:01.000Z",
      traceId: "trace-debug",
      sessionId: "session-debug",
      turnId: "turn-1",
      payload: {
        usage: {
          inputTokens: 128,
          outputTokens: 32,
          totalTokens: 160,
          cacheReadTokens: 64,
          cacheWriteTokens: 12,
        },
      },
    },
    {
      id: "evt-3",
      type: "turn_complete",
      timestamp: "2026-05-04T01:00:02.000Z",
      traceId: "trace-debug",
      sessionId: "session-debug",
      turnId: "turn-1",
      payload: {
        resultType: "success",
        cacheStats: {
          totalMessages: 2,
          cachedMessages: 1,
          lastCacheHit: true,
        },
      },
    },
  ];
  const eventLines = events.map((event) => JSON.stringify(event));
  if (options.includeBadLine) eventLines.splice(1, 0, "{bad json");
  await writeFile(eventPath, `${eventLines.join("\n")}\n`, "utf8");

  await writeFile(
    logPath,
    `${JSON.stringify({
      timestamp: "2026-05-04T01:00:00.100Z",
      level: "debug",
      message: "Context built",
      traceId: "trace-debug",
      sessionId: "session-debug",
      context: {
        totalChars: 40,
        totalTokens: 10,
        sections: [{ name: "Skills", chars: 24, tokens: 6 }],
      },
    })}\n`,
    "utf8",
  );

  return { root, logDir, eventPath };
}

async function createProjectFixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-debug-project-"));
  const logDir = join(root, "logs");
  await mkdir(logDir);
  const eventPath = join(root, "events.jsonl");
  const dbPath = join(root, "db.sqlite");
  const events = Array.from({ length: 12 }, (_, index) => ({
    id: `evt-new-${index}`,
    type: "turn_complete",
    timestamp: `2026-05-04T02:${String(index).padStart(2, "0")}:00.000Z`,
    traceId: `trace-new-${index}`,
    sessionId: "session-new",
    payload: { resultType: "success" },
  }));
  events.push({
    id: "evt-old",
    type: "turn_complete",
    timestamp: "2026-05-04T01:00:00.000Z",
    traceId: "trace-old",
    sessionId: "session-old",
    payload: { resultType: "success" },
  });
  await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(join(logDir, "zcode.jsonl"), "", "utf8");

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      create table session (
        id text primary key,
        project_id text not null,
        title text not null,
        directory text not null,
        time_created integer not null,
        time_updated integer not null
      );
    `);
    const insert = db.prepare(
      "insert into session (id, project_id, title, directory, time_created, time_updated) values (?, ?, ?, ?, ?, ?)",
    );
    insert.run("session-old", "project-old", "Old", "/work/old", 1000, 1000);
    insert.run("session-new", "project-new", "New", "/work/new", 2000, 2000);
    db.exec(`
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
      create table part (
        id text primary key,
        message_id text not null,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
    `);
    const insertMessage = db.prepare(
      "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
    );
    insertMessage.run(
      "message-old-user",
      "session-old",
      1100,
      1100,
      JSON.stringify({ role: "user" }),
    );
    insertMessage.run(
      "message-new-user",
      "session-new",
      2100,
      2100,
      JSON.stringify({ role: "user", content: "new project first prompt" }),
    );
    const insertPart = db.prepare(
      "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
    );
    insertPart.run(
      "part-old-user-text",
      "message-old-user",
      "session-old",
      1100,
      1100,
      JSON.stringify({ type: "text", text: "old project part prompt" }),
    );
    insertPart.run(
      "part-old-step-finish",
      "message-old-assistant",
      "session-old",
      1200,
      1200,
      JSON.stringify({
        type: "step-finish",
        tokens: {
          input: 100,
          output: 25,
          total: 125,
          cache: { read: 20, write: 5 },
        },
      }),
    );
  } finally {
    db.close();
  }

  return { root, logDir, eventPath, dbPath };
}
