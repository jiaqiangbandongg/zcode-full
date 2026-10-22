import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { conversationRowSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  collectConversationShareWorkflowSnapshot,
  type ShareWorkflowReader,
} from "../src/conversation-share/conversationShareWorkflowSnapshot.js";
import { buildConversationSharePublicProjection } from "../src/conversation-share/conversationSharePublicProjection.js";
import {
  buildConversationShareConfirmRequest,
  verifyConversationShareIntegrity,
} from "../src/conversation-share/conversationShareIntegrity.js";
import type { ConversationShareCapabilities } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

const capabilities: ConversationShareCapabilities = {
  schema_version: 1,
  ttl_ms: 10000,
  access_modes: ["public_readonly"],
  max_rows: 200,
  max_payload_bytes: 1000000,
  max_artifact_count: 20,
  max_artifact_bytes: 10000,
  max_total_artifact_bytes: 100000,
  allowed_artifacts: [{ type: "text", extensions: ["md"], mime_types: ["text/markdown"] }],
  content_block_versions: { workflow: 1 },
};
const rows: ConversationRow[] = [
  {
    rowId: 1,
    turnId: "t1",
    productTurnId: "p1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "backgroundResult",
    state: "completedSuccess",
    startedAt: 1,
    originMeta: {
      backgroundSource: "workflow",
      workId: "private-run",
      title: "军棋",
      workflowNotification: { kind: "terminal", status: "completed", summary: "done" },
    },
  },
  {
    rowId: 2,
    turnId: "t1",
    productTurnId: "p1",
    createdAt: 1,
    createdAtSeq: 2,
    kind: "assistantText",
    state: "complete",
    text: "原始最终正文",
  },
];
function reader(): ShareWorkflowReader {
  return {
    conversationWorkflowRunsV4: vi.fn().mockResolvedValue({ runs: [] }),
    conversationWorkflowRunEventsV4: vi.fn().mockResolvedValue({
      hasMore: false,
      events: [
        { sequence: 1, type: "run-started", payload: {} },
        {
          sequence: 2,
          type: "artifact-published",
          payload: { artifact: { id: "board", kind: "board", version: 1, title: "进度看板" } },
        },
        {
          sequence: 3,
          type: "artifact-published",
          payload: { artifact: { id: "report", kind: "markdown", version: 1, title: "交付报告" } },
        },
        { sequence: 4, type: "run-settled", payload: { status: "completed" } },
      ],
    }),
    conversationWorkflowRunArtifactsV4: vi.fn().mockResolvedValue({
      artifacts: [
        {
          id: "board",
          kind: "board",
          versions: [
            {
              version: 1,
              title: "进度看板",
              spec: { key: "id", status: "status", columns: ["done"] },
            },
          ],
        },
        {
          id: "report",
          kind: "markdown",
          versions: [
            { version: 1, title: "交付报告", contentType: "text/markdown" },
            { version: 2, title: "后续版本" },
          ],
        },
      ],
    }),
    conversationWorkflowRunArtifactDataV4: vi.fn().mockResolvedValue({
      hasMore: false,
      items: [
        { sequence: 3, siteId: "report", ordinal: 1, item: { id: "one", status: "done" } },
        { sequence: 5, siteId: "report", ordinal: 2, item: { id: "later", status: "done" } },
      ],
    }),
    conversationWorkflowRunArtifactReadV4: vi.fn().mockResolvedValue({
      dataBase64: Buffer.from("# Report").toString("base64"),
      totalBytes: 8,
      nextOffset: null,
      mediaType: "text/markdown",
    }),
  };
}
const input = {
  workspacePath: "/workspace",
  workspaceIdentity: "remote-a",
  remoteSessionId: "attachment-a",
  sessionId: "s1",
};
describe("workflow 分享冻结快照", () => {
  it("真实会话中的失败编译不生成空 run，完成轮保留统计和文档正文", async () => {
    const raw = JSON.parse(
      await readFile(
        new URL("./fixtures/share-workflow-parity-rows.json", import.meta.url),
        "utf8",
      ),
    );
    const actualRows = raw.map((row: unknown) => conversationRowSchema.parse(row));
    const agent = reader();
    vi.mocked(agent.conversationWorkflowRunsV4).mockResolvedValue({
      runs: [
        {
          runId: "run-completed",
          toolCallId: "create-completed",
          status: "completed",
          resumable: false,
        },
      ],
    });
    const snapshot = await collectConversationShareWorkflowSnapshot({
      agent,
      input,
      rows: actualRows,
      allRows: actualRows,
      capabilities: { ...capabilities, content_block_versions: { workflow: 2 } },
      capturedAt: 99,
    });
    expect(snapshot.drafts).toHaveLength(2);
    expect(snapshot.drafts.map((draft) => draft.payload.completion)).toEqual([false, true]);
    expect(snapshot.drafts[1]?.payload.duration_ms).toBe(2525893);
    expect(snapshot.drafts[1]?.payload.artifacts.find((a) => a.id === "report")).toMatchObject({
      preview_text: "# Report",
    });
    expect(agent.conversationWorkflowRunEventsV4).toHaveBeenCalledTimes(1);
  });
  it("在物化字节前执行总资源预算，不把超限文件留在上传集合", async () => {
    const snapshot = await collectConversationShareWorkflowSnapshot({
      agent: reader(),
      input,
      rows,
      allRows: rows,
      capabilities: { ...capabilities, max_total_artifact_bytes: 4 },
      capturedAt: 99,
    });
    expect(snapshot.bytes.size).toBe(0);
    expect(
      snapshot.drafts[0]?.payload.artifacts.find((artifact) => artifact.id === "report"),
    ).toMatchObject({ unavailable: "limit_exceeded" });
  });
  it("完成轮独立关联 journal，固定版本和看板水位，公开 ID 闭包", async () => {
    const agent = reader();
    const snapshot = await collectConversationShareWorkflowSnapshot({
      agent,
      input,
      rows,
      allRows: rows,
      capabilities,
      capturedAt: 99,
    });
    expect(snapshot.drafts[0]?.payload.run?.status).toBe("completed");
    expect(snapshot.drafts[0]?.payload.artifacts[0]).toMatchObject({
      kind: "board",
      items: [{ item: { id: "one" } }],
    });
    expect(agent.conversationWorkflowRunArtifactReadV4).toHaveBeenCalledWith(
      expect.objectContaining({ ...input, version: 1 }),
    );
    const projection = buildConversationSharePublicProjection({
      rows: snapshot.rows,
      selectedProductTurnIds: ["p1"],
      contentDrafts: snapshot.drafts,
    });
    expect(projection.contentBlocks?.[0]?.resource_ids).toEqual(["share-artifact-1"]);
    expect(JSON.stringify(projection)).not.toContain("private-run");
    const request = buildConversationShareConfirmRequest({
      selected_product_turn_ids: projection.selectedProductTurnIds,
      projection: { rows: projection.rows, content_blocks: projection.contentBlocks },
      artifacts: projection.artifacts.map((a) => a.descriptor),
      disclosure_confirmation: {
        version: 1,
        accepted_at: 1,
        acknowledged_no_secret_detection: true,
      },
    });
    expect(
      verifyConversationShareIntegrity({
        rawRows: projection.rows,
        rawArtifacts: projection.artifacts.map((a) => a.descriptor),
        rawContentBlocks: projection.contentBlocks,
        integrity: request.integrity,
      }),
    ).toBe(true);
    expect(
      verifyConversationShareIntegrity({
        rawRows: projection.rows,
        rawArtifacts: projection.artifacts.map((a) => a.descriptor),
        rawContentBlocks: [],
        integrity: request.integrity,
      }),
    ).toBe(false);
  });
  it("源读取失败保留摘要和原正文，不伪造已完成状态", async () => {
    const agent = reader();
    vi.mocked(agent.conversationWorkflowRunEventsV4).mockRejectedValue(new Error("offline"));
    const result = await collectConversationShareWorkflowSnapshot({
      agent,
      input,
      rows,
      allRows: rows,
      capabilities,
      capturedAt: 99,
    });
    expect(result.drafts[0]?.payload.unavailable).toBe("source_unavailable");
    expect(result.drafts[0]?.payload.run).toBeUndefined();
    expect(result.rows).toContain(rows[1]);
    expect(result.rows.at(-1)).toMatchObject({
      kind: "assistantText",
      text: expect.stringContaining("快照不可用"),
    });
  });
});

describe("workflow 分享边界回归", () => {
  const collect = (agent: ShareWorkflowReader, limits = capabilities) =>
    collectConversationShareWorkflowSnapshot({
      agent,
      input,
      rows,
      allRows: rows,
      capabilities: { ...limits, content_block_versions: { workflow: 2 } },
      capturedAt: 99,
    });

  it("按游标读取多页 journal，最后一页决定产物版本和看板水位", async () => {
    const agent = reader();
    const complete = await agent.conversationWorkflowRunEventsV4({
      ...input,
      runId: "private-run",
    });
    vi.mocked(agent.conversationWorkflowRunEventsV4)
      .mockClear()
      .mockResolvedValueOnce({ events: complete.events.slice(0, 2), hasMore: true })
      .mockResolvedValueOnce({ events: complete.events.slice(2), hasMore: false });
    const snapshot = await collect(agent);
    expect(snapshot.drafts[0]?.payload.unavailable).toBeUndefined();
    expect(snapshot.drafts[0]?.payload.run?.status).toBe("completed");
    expect(snapshot.bytes.size).toBe(1);
    expect(agent.conversationWorkflowRunEventsV4).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ...input, runId: "private-run", afterSequence: 2 }),
    );
    expect(snapshot.drafts[0]?.payload.artifacts[0]?.items).toHaveLength(1);
  });

  it.each(["empty", "duplicate", "limit"])("拒绝 %s 分页且不留下上传资源", async (failure) => {
    const agent = reader();
    const page = { events: [{ sequence: 1, type: "run-started", payload: {} }], hasMore: true };
    vi.mocked(agent.conversationWorkflowRunEventsV4)
      .mockResolvedValueOnce(page)
      .mockResolvedValue(
        failure === "empty"
          ? { events: [], hasMore: true }
          : failure === "duplicate"
            ? page
            : {
                events: Array.from({ length: 20000 }, (_, index) => ({
                  sequence: index + 2,
                  type: "run-started",
                  payload: {},
                })),
                hasMore: false,
              },
      );
    const snapshot = await collect(agent);
    expect(agent.conversationWorkflowRunEventsV4).toHaveBeenCalledTimes(2);
    expect(snapshot.drafts[0]?.payload.unavailable).toBe("source_unavailable");
    expect(snapshot.bytes.size).toBe(0);
  });

  it.each(["Report 2026.10", "v1.2 notes", "report.md"])(
    "标题 %s 不改变下载扩展名",
    async (title) => {
      const agent = reader();
      const metadata = await agent.conversationWorkflowRunArtifactsV4({
        ...input,
        runId: "private-run",
      });
      metadata.artifacts.find((artifact) => artifact.id === "report")!.versions[0]!.title = title;
      vi.mocked(agent.conversationWorkflowRunArtifactsV4).mockResolvedValue(metadata);
      const snapshot = await collect(agent);
      const projection = buildConversationSharePublicProjection({
        rows: snapshot.rows,
        selectedProductTurnIds: ["p1"],
        contentDrafts: snapshot.drafts,
      });
      expect(projection.artifacts[0]?.descriptor.extension).toBe("md");
      expect(projection.artifacts[0]?.descriptor.display_name).toBe(
        title.endsWith(".md") ? title : `${title}.md`,
      );
    },
  );

  it("文本解码失败不登记字节、行和预算，后续有效产物仍能分享", async () => {
    const agent = reader();
    const events = await agent.conversationWorkflowRunEventsV4({ ...input, runId: "private-run" });
    events.events.splice(3, 0, {
      sequence: 4,
      type: "artifact-published",
      payload: { artifact: { id: "valid", kind: "markdown", version: 1, title: "有效文档" } },
    });
    events.events.at(-1)!.sequence = 5;
    vi.mocked(agent.conversationWorkflowRunEventsV4).mockResolvedValue(events);
    const metadata = await agent.conversationWorkflowRunArtifactsV4({
      ...input,
      runId: "private-run",
    });
    metadata.artifacts.push({
      id: "valid",
      kind: "markdown",
      versions: [{ version: 1, title: "有效文档", contentType: "text/markdown" }],
    } as (typeof metadata.artifacts)[number]);
    vi.mocked(agent.conversationWorkflowRunArtifactsV4).mockResolvedValue(metadata);
    vi.mocked(agent.conversationWorkflowRunArtifactReadV4).mockResolvedValueOnce({
      dataBase64: Buffer.from([0xff]).toString("base64"),
      totalBytes: 1,
      nextOffset: null,
      mediaType: "text/markdown",
    });
    const snapshot = await collect(agent, {
      ...capabilities,
      max_artifact_count: 1,
      max_total_artifact_bytes: 8,
    });
    expect(
      snapshot.drafts[0]?.payload.artifacts.find((artifact) => artifact.id === "report"),
    ).toMatchObject({ unavailable: "source_unavailable" });
    expect(
      snapshot.drafts[0]?.payload.artifacts.find((artifact) => artifact.id === "valid"),
    ).toMatchObject({ resource_id: "workflow-resource-1", preview_text: "# Report" });
    expect(snapshot.bytes.size).toBe(1);
    expect(snapshot.rows.filter((row) => row.kind === "artifact")).toHaveLength(1);
    expect([...snapshot.bytes.values()][0]).toEqual(Buffer.from("# Report"));
  });
});

describe("workflow preflight metadata budget", () => {
  it.each([8, 10001, 100001])(
    "checks declared bytes %s without reading artifact content",
    async (declaredBytes) => {
      const agent = reader();
      const metadata = await agent.conversationWorkflowRunArtifactsV4({
        ...input,
        runId: "private-run",
      });
      metadata.artifacts.find((artifact) => artifact.id === "report")!.versions[0]!.bytes =
        declaredBytes;
      const snapshot = await collectConversationShareWorkflowSnapshot({
        agent,
        input,
        rows,
        allRows: rows,
        capabilities,
        capturedAt: 99,
        preflight: true,
      });
      expect(agent.conversationWorkflowRunArtifactReadV4).not.toHaveBeenCalled();
      expect(snapshot.bytes.size).toBe(0);
      expect(
        snapshot.drafts[0]?.payload.artifacts.find((artifact) => artifact.id === "report"),
      ).toMatchObject(
        declaredBytes > capabilities.max_artifact_bytes
          ? { unavailable: "limit_exceeded" }
          : { bytes: declaredBytes },
      );
      if (declaredBytes === 8) {
        await collectConversationShareWorkflowSnapshot({
          agent,
          input,
          rows,
          allRows: rows,
          capabilities,
          capturedAt: 99,
        });
        expect(agent.conversationWorkflowRunArtifactReadV4).toHaveBeenCalledTimes(1);
      }
    },
  );
});
