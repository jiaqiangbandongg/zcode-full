import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";

import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import { sha256ConversationShareJson } from "../src/conversation-share/conversationShareIntegrity.js";
import { ConversationShareMockApiClient } from "./helpers/conversationShareMockApiClient.js";
import { ConversationShareService } from "../src/conversation-share/conversationShareService.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ConversationShareService import", () => {
  it("installs imported artifacts under the captured local workspace without deleting siblings on failure", async () => {
    const conversationRoot = await mkdtemp(join(tmpdir(), "zcode-share-import-default-"));
    const targetRoot = await mkdtemp(join(tmpdir(), "zcode-share-import-target-"));
    roots.push(conversationRoot, targetRoot);
    await writeFile(join(targetRoot, "keep.txt"), "keep", "utf8");
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: conversationRoot,
      zcodeSessionService: {
        createSession: vi.fn(async () => {
          throw new Error("injected commit failure");
        }) as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => {
          throw new Error("unexpected artifact read");
        },
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows: [
            {
              rowId: 1,
              turnId: "turn-1",
              entityId: "entity-1",
              productTurnId: "product-1",
              createdAt: 1,
              createdAtSeq: 1,
              kind: "turnHeader" as const,
              origin: "userInput" as const,
              state: "completedSuccess" as const,
              startedAt: 1,
              endedAt: 2,
            },
          ],
          atSeq: 1,
          atRevision: 1,
          atLogEpoch: "epoch",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(),
      },
    });
    const share = await service.publish(
      {
        workspacePath: targetRoot,
        sessionId: "session-1",
        title: "Shared Research",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-target-1",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-1",
    );
    await expect(
      service.importShare(
        {
          shareCode: share.share_code,
          clientRequestId: "import-target-1",
          targetWorkspacePath: targetRoot,
          targetWorkspaceKind: "local",
        },
        "operation-target-1",
      ),
    ).rejects.toThrow("injected commit failure");
    await expect(readFile(join(targetRoot, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("发布后导入到新 workspace，并把 shared_context 交给原子 session create", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const createSession = vi.fn(async () => ({
      session: { sessionId: "imported-session" },
    }));
    const rows = [
      {
        rowId: 1,
        turnId: "turn-1",
        entityId: "entity-1",
        productTurnId: "product-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "turnHeader" as const,
        origin: "userInput" as const,
        state: "completedSuccess" as const,
        startedAt: 1,
        endedAt: 2,
      },
      {
        rowId: 2,
        turnId: "turn-1",
        entityId: "entity-2",
        productTurnId: "product-1",
        createdAt: 2,
        createdAtSeq: 2,
        kind: "userInput" as const,
        origin: "realUser" as const,
        text: "Continue this work",
      },
    ];
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      zcodeSessionService: {
        createSession: createSession as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => {
          throw new Error("unexpected artifact read");
        },
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows,
          atSeq: 2,
          atRevision: 3,
          atLogEpoch: "epoch-1",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(),
      },
    });
    const share = await service.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Shared Research",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-1",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-2",
    );

    const imported = await service.importShare(
      { shareCode: share.share_code, clientRequestId: "import-1" },
      "operation-1",
    );
    expect(imported.sessionId).toBe("imported-session");
    const shareRootEntries = await readdir(join(imported.workspacePath, ".zcode-share"));
    expect(shareRootEntries).toHaveLength(1);
    expect(
      (
        await stat(
          join(imported.workspacePath, ".zcode-share", shareRootEntries[0]!, "shared-artifacts"),
        )
      ).isDirectory(),
    ).toBe(true);
    await expect(
      readFile(
        join(
          imported.workspacePath,
          ".zcode-share",
          shareRootEntries[0]!,
          ".zcode-share-import.json",
        ),
      ),
    ).rejects.toThrow();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: imported.workspacePath,
        importedHistory: expect.objectContaining({
          source: "sharedContext",
          markdown: expect.stringContaining("Continue this work"),
        }),
      }),
    );
  });

  it("英文界面：标题带 From Share 前缀，但持久化的回链仍是规范 /cn/share/", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-locale-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const createSession = vi.fn(async () => ({ session: { sessionId: "imported-session" } }));
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      zcodeSessionService: {
        createSession: createSession as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => {
          throw new Error("unexpected artifact read");
        },
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows: [
            {
              rowId: 1,
              turnId: "turn-1",
              entityId: "entity-1",
              productTurnId: "product-1",
              createdAt: 1,
              createdAtSeq: 1,
              kind: "turnHeader" as const,
              origin: "userInput" as const,
              state: "completedSuccess" as const,
              startedAt: 1,
              endedAt: 2,
            },
          ],
          atSeq: 1,
          atRevision: 1,
          atLogEpoch: "epoch",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(),
      },
    });
    const share = await service.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Shared Research",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-locale",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-locale",
    );

    const imported = await service.importShare(
      { shareCode: share.share_code, clientRequestId: "import-locale", locale: "en-US" },
      "operation-locale",
    );

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        importedHistory: expect.objectContaining({ title: "From Share: Shared Research" }),
      }),
    );
    // sharedContextImportV2StateSchema 硬编码 /^\/cn\/share\/[^/]+$/，持久化的回链
    // 绝不能跟随界面语言变成 /share/<code>，否则英文界面导入直接挂在 schema 上。
    expect(new URL(imported.shareUrl).pathname).toMatch(/^\/cn\/share\/[^/]+$/u);
    const provenanceUrl = (
      createSession.mock.calls[0]![0] as {
        importedHistory: { provenance: { shareUrl: string } };
      }
    ).importedHistory.provenance.shareUrl;
    expect(new URL(provenanceUrl).pathname).toMatch(/^\/cn\/share\/[^/]+$/u);
  });

  it("落盘公开 rows，并能按 contextId 取回用于只读块", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-rows-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      zcodeSessionService: {
        createSession: vi.fn(async () => ({ session: { sessionId: "imported-session" } })) as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => {
          throw new Error("unexpected artifact read");
        },
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows: [
            {
              rowId: 1,
              turnId: "turn-1",
              entityId: "entity-1",
              productTurnId: "product-1",
              createdAt: 1,
              createdAtSeq: 1,
              kind: "turnHeader" as const,
              origin: "userInput" as const,
              state: "completedSuccess" as const,
              startedAt: 1,
              endedAt: 2,
            },
            {
              rowId: 2,
              turnId: "turn-1",
              entityId: "entity-2",
              productTurnId: "product-1",
              createdAt: 2,
              createdAtSeq: 2,
              kind: "userInput" as const,
              origin: "realUser" as const,
              text: "Continue this work",
            },
          ],
          atSeq: 2,
          atRevision: 1,
          atLogEpoch: "epoch",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(),
      },
    });
    const share = await service.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Shared Research",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-rows",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-rows",
    );

    const imported = await service.importShare(
      { shareCode: share.share_code, clientRequestId: "import-rows" },
      "operation-rows",
    );

    const loaded = await service.getImportedConversation({
      workspacePath: imported.workspacePath,
      contextId: imported.contextId,
    });
    expect(loaded?.rows.map((row) => row.kind)).toEqual(["turnHeader", "userInput"]);
    expect(loaded?.title).toBe("Shared Research");
    // 目录名是 share_id，不等于 contextId：拿错 contextId 必须落空而不是返回别人的副本。
    await expect(
      service.getImportedConversation({
        workspacePath: imported.workspacePath,
        contextId: "shared-context-does-not-exist",
      }),
    ).resolves.toBeNull();
    await expect(
      service.getImportedConversation({ workspacePath: root, contextId: imported.contextId }),
    ).resolves.toBeTruthy();
  });

  it("reuses the completed import for the same client request", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-dedupe-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const createSession = vi.fn(async () => ({ session: { sessionId: "imported-session" } }));
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      zcodeSessionService: {
        createSession: createSession as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => {
          throw new Error("unexpected artifact read");
        },
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows: [
            {
              rowId: 1,
              turnId: "turn-1",
              entityId: "entity-1",
              productTurnId: "product-1",
              createdAt: 1,
              createdAtSeq: 1,
              kind: "turnHeader" as const,
              origin: "userInput" as const,
              state: "completedSuccess" as const,
              startedAt: 1,
              endedAt: 2,
            },
          ],
          atSeq: 1,
          atRevision: 1,
          atLogEpoch: "epoch",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(),
      },
    });
    const publish = await service.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Shared Research",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-1",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-3",
    );
    const first = await service.importShare(
      { shareCode: publish.share_code, clientRequestId: "same-request" },
      "operation-1",
    );
    const second = await service.importShare(
      { shareCode: publish.share_code, clientRequestId: "new-request" },
      "operation-2",
    );
    expect(second).toMatchObject({
      ...first,
      reused: true,
    });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("对象存储把 .md 标成别的 content-type 时仍能导入；SHA-256 不符仍然拒绝", async () => {
    const mdBytes = new TextEncoder().encode("# feature map\n");
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-mime-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const rows = [
      {
        rowId: 1,
        turnId: "turn-1",
        entityId: "entity-1",
        productTurnId: "product-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "turnHeader" as const,
        origin: "userInput" as const,
        state: "completedSuccess" as const,
        startedAt: 1,
        endedAt: 2,
        fileChanges: { files: 1, additions: 1, deletions: 0, state: "active" as const },
      },
      {
        rowId: 2,
        turnId: "turn-1",
        entityId: "entity-2",
        productTurnId: "product-1",
        createdAt: 2,
        createdAtSeq: 2,
        kind: "assistantText" as const,
        text: "已生成 feature_map.md",
        state: "complete" as const,
      },
    ];
    const createService = (download: (url: string) => Promise<Response>) =>
      new ConversationShareService({
        client,
        conversationWorkspaceRoot: root,
        download,
        zcodeSessionService: {
          createSession: vi.fn(async () => ({
            session: { sessionId: "imported-session" },
          })) as never,
          listSessions: vi.fn(async () => []),
        },
        artifactSource: {
          read: async () => ({ bytes: mdBytes, canonicalPath: `${root}/feature_map.md` }),
        },
        zcodeAgentService: {
          conversationRowsRangeV4: vi.fn(async () => ({
            rows,
            atSeq: 2,
            atRevision: 1,
            atLogEpoch: "epoch",
            hasMore: false,
          })),
          conversationFileChangesV4: vi.fn(async () => ({
            files: 1,
            additions: 1,
            deletions: 0,
            state: "active" as const,
            items: [
              {
                path: "feature_map.md",
                additions: 1,
                deletions: 0,
                writeCount: 1,
                toolNames: ["Write"],
                patches: [],
              },
            ],
          })),
        },
      });

    // 对象存储/CDN 常把 .md 标成 text/plain，与发布时的 text/markdown 无关。
    const mislabeled = createService(
      async () => new Response(mdBytes, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const share = await mislabeled.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Feature map",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-mime",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-mime",
    );
    const imported = await mislabeled.importShare(
      { shareCode: share.share_code, clientRequestId: "import-mime" },
      "operation-mime",
    );
    const artifactDir = join(
      imported.workspacePath,
      ".zcode-share",
      (await readdir(join(imported.workspacePath, ".zcode-share")))[0]!,
      "shared-artifacts",
    );
    expect(await readdir(artifactDir)).toHaveLength(1);

    // 完整性门禁仍在 SHA-256 上：字节被改过就必须拒绝。
    // 必须换一个 share —— 同 share + 同 workspace 会命中完成索引直接复用，根本不会下载。
    const tampered = createService(
      async () =>
        new Response(new TextEncoder().encode("tampered"), {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }),
    );
    const secondShare = await tampered.publish(
      {
        workspacePath: root,
        sessionId: "session-2",
        title: "Feature map again",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-mime-2",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-mime-2",
    );
    expect(secondShare.share_code).not.toBe(share.share_code);
    await expect(
      tampered.importShare(
        { shareCode: secondShare.share_code, clientRequestId: "import-mime-tampered" },
        "operation-mime-tampered",
      ),
    ).rejects.toMatchObject({ kind: "invalid_contract" });
  });

  it("Content-Length 超过 manifest 声明时在读 body 前中断，不把超大响应读进内存", async () => {
    const mdBytes = new TextEncoder().encode("# feature map\n");
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-oversize-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    // Bug 根因：完整性校验（size + SHA-256）此前在 response.arrayBuffer() 之后才执行，
    // 被篡改/损坏的存储可以让客户端先把超大 payload 全量读进内存再发现不符。
    // 预检必须在读 body 前：Content-Length 声明超过 size_bytes 即中断下载。
    const arrayBuffer = vi.fn(async () => {
      throw new Error("body must not be read when Content-Length exceeds the manifest size");
    });
    // markdown 预览候选必须有 active fileChanges 作为存在性证据，否则不会生成 artifact、
    // download 根本不会被调用。
    const fileChanges = async () => ({
      files: 1,
      additions: 1,
      deletions: 0,
      state: "active" as const,
      items: [
        {
          path: "feature_map.md",
          additions: 1,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    });
    const oversized = {
      ok: true,
      headers: new Headers({ "content-length": "999999" }),
      arrayBuffer,
    } as unknown as Response;
    const download = vi.fn(async () => oversized);
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      download,
      zcodeSessionService: {
        createSession: vi.fn(async () => ({ session: { sessionId: "s" } })) as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => ({ bytes: mdBytes, canonicalPath: `${root}/feature_map.md` }),
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows: [
            {
              rowId: 1,
              turnId: "turn-1",
              entityId: "entity-1",
              productTurnId: "product-1",
              createdAt: 1,
              createdAtSeq: 1,
              kind: "turnHeader" as const,
              origin: "userInput" as const,
              state: "completedSuccess" as const,
              startedAt: 1,
              endedAt: 2,
            },
            {
              rowId: 2,
              turnId: "turn-1",
              entityId: "entity-2",
              productTurnId: "product-1",
              createdAt: 2,
              createdAtSeq: 2,
              kind: "assistantText" as const,
              text: "已生成 feature_map.md",
              state: "complete" as const,
            },
          ],
          atSeq: 2,
          atRevision: 1,
          atLogEpoch: "epoch",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(fileChanges),
      },
    });
    const share = await service.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Feature map",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-oversize",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-oversize",
    );

    await expect(
      service.importShare(
        { shareCode: share.share_code, clientRequestId: "import-oversize" },
        "operation-oversize",
      ),
    ).rejects.toMatchObject({
      kind: "invalid_contract",
      issues: [expect.objectContaining({ code: "artifact_changed", actual: 999_999, limit: 14 })],
    });
    expect(download).toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("下载挂住时按超时以 network 失败，不会无限停在 downloading 阶段", async () => {
    const mdBytes = new TextEncoder().encode("# feature map\n");
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-timeout-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    // Bug 根因：download 兜底是裸 fetch，无 AbortSignal/超时；对象存储连接挂住时导入
    // 会停在 downloading 阶段直到 undici 默认 ~300s 兜底，体验上等于卡死。
    const fileChanges = async () => ({
      files: 1,
      additions: 1,
      deletions: 0,
      state: "active" as const,
      items: [
        {
          path: "feature_map.md",
          additions: 1,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    });
    const download = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      download,
      downloadTimeoutMs: 20,
      zcodeSessionService: {
        createSession: vi.fn(async () => ({ session: { sessionId: "s" } })) as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => ({ bytes: mdBytes, canonicalPath: `${root}/feature_map.md` }),
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows: [
            {
              rowId: 1,
              turnId: "turn-1",
              entityId: "entity-1",
              productTurnId: "product-1",
              createdAt: 1,
              createdAtSeq: 1,
              kind: "turnHeader" as const,
              origin: "userInput" as const,
              state: "completedSuccess" as const,
              startedAt: 1,
              endedAt: 2,
            },
            {
              rowId: 2,
              turnId: "turn-1",
              entityId: "entity-2",
              productTurnId: "product-1",
              createdAt: 2,
              createdAtSeq: 2,
              kind: "assistantText" as const,
              text: "已生成 feature_map.md",
              state: "complete" as const,
            },
          ],
          atSeq: 2,
          atRevision: 1,
          atLogEpoch: "epoch",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(fileChanges),
      },
    });
    const share = await service.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Feature map",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-download-timeout",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-download-timeout",
    );

    await expect(
      service.importShare(
        { shareCode: share.share_code, clientRequestId: "import-download-timeout" },
        "operation-download-timeout",
      ),
    ).rejects.toMatchObject({
      kind: "network",
      message: "Conversation artifact download timed out",
      issues: [expect.objectContaining({ code: "unknown", phase: "downloading" })],
    });
  });

  it("回链跟随环境，不再写死生产站", async () => {
    // Bug 根因：兜底写死 https://zcode.z.ai/cn/share，测试环境（API base 走
    // zcode.z.ai）导入后点分割线会打开另一个环境的分享页。
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-endpoint-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const build = (shareWebUrl?: string) =>
      new ConversationShareService({
        client,
        conversationWorkspaceRoot: root,
        ...(shareWebUrl ? { shareWebUrl } : {}),
        zcodeSessionService: {
          createSession: vi.fn(async () => ({
            session: { sessionId: "imported-session" },
          })) as never,
          listSessions: vi.fn(async () => []),
        },
        artifactSource: {
          read: async () => {
            throw new Error("unexpected artifact read");
          },
        },
        zcodeAgentService: {
          conversationRowsRangeV4: vi.fn(async () => ({
            rows: [
              {
                rowId: 1,
                turnId: "turn-1",
                entityId: "entity-1",
                productTurnId: "product-1",
                createdAt: 1,
                createdAtSeq: 1,
                kind: "turnHeader" as const,
                origin: "userInput" as const,
                state: "completedSuccess" as const,
                startedAt: 1,
                endedAt: 2,
              },
            ],
            atSeq: 1,
            atRevision: 1,
            atLogEpoch: "epoch",
            hasMore: false,
          })),
          conversationFileChangesV4: vi.fn(),
        },
      });

    const explicit = build("https://zcode.example.test/cn/share");
    const share = await explicit.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Endpoint",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-endpoint",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-endpoint",
    );
    const imported = await explicit.importShare(
      { shareCode: share.share_code, clientRequestId: "import-endpoint" },
      "operation-endpoint",
    );
    // 显式 option 仍是最高优先级。
    expect(imported.shareUrl).toBe(
      `https://zcode.example.test/cn/share/${encodeURIComponent(share.share_code)}`,
    );

    // 未显式指定时按环境推导：origin 必须与 API base 用的同一个解析器一致，
    // 路径仍是规范 /cn/share/<code>（sharedContextImport schema 要求）。
    // 必须真的切一个非生产 endpoint，否则推导值与旧的写死值恰好相同，测不出回归。
    vi.stubEnv("ZCODE_BASE_URL", "https://zcode.z.ai");
    const derived = build();
    const secondShare = await derived.publish(
      {
        workspacePath: root,
        sessionId: "session-2",
        title: "Endpoint derived",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-endpoint-2",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-endpoint-2",
    );
    const derivedImport = await derived.importShare(
      { shareCode: secondShare.share_code, clientRequestId: "import-endpoint-2" },
      "operation-endpoint-2",
    );
    const derivedUrl = new URL(derivedImport.shareUrl);
    expect(derivedUrl.origin).toBe("https://zcode.z.ai");
    expect(derivedUrl.origin).toBe(resolveRuntimeZCodeEndpointOrigin(process.env));
    expect(derivedUrl.pathname).toBe(`/cn/share/${encodeURIComponent(secondShare.share_code)}`);
    vi.unstubAllEnvs();
  });

  // Bug 回归（CR-02）：createSession 成功后 rm(markerPath) / reportImportProgress 仍在
  // 同一个 try 内，catch 会 rm -rf importRoot，把已经安装进 workspace 且被新 session
  // 的 provenance 引用的 artifacts 删掉，用户拿到一个引用缺失文件的会话。
  // 失败半径必须止于 createSession 之前。
  it("createSession 成功后的失败不再删除已提交的 importRoot", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-commit-radius-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      zcodeSessionService: {
        createSession: vi.fn(async () => ({ session: { sessionId: "imported-session" } })) as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => {
          throw new Error("unexpected artifact read");
        },
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows: [
            {
              rowId: 1,
              turnId: "turn-1",
              entityId: "entity-1",
              productTurnId: "product-1",
              createdAt: 1,
              createdAtSeq: 1,
              kind: "turnHeader" as const,
              origin: "userInput" as const,
              state: "completedSuccess" as const,
              startedAt: 1,
              endedAt: 2,
            },
          ],
          atSeq: 1,
          atRevision: 1,
          atLogEpoch: "epoch",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(),
      },
    });
    const share = await service.publish(
      {
        workspacePath: root,
        sessionId: "session-1",
        title: "Shared Research",
        accessMode: "public_importable",
        selection: { kind: "all" },
        clientRequestId: "publish-commit-radius",
        disclosureAcceptedAt: 9_000,
      },
      "publish-op-commit-radius",
    );

    // Emitter.fire 不吞 listener 异常，这里精确复现「createSession 之后失败」。
    const subscription = service.onDynamicImportProgress("operation-commit-radius")((progress) => {
      if (progress.phase === "complete") {
        throw new Error("injected post-commit failure");
      }
    });
    try {
      await expect(
        service.importShare(
          { shareCode: share.share_code, clientRequestId: "import-commit-radius" },
          "operation-commit-radius",
        ),
      ).rejects.toThrow("injected post-commit failure");
    } finally {
      subscription.dispose();
    }

    const shareRootEntries = await readdir(join(root, ".zcode-share"));
    expect(shareRootEntries).toHaveLength(1);
    const importRoot = join(root, ".zcode-share", shareRootEntries[0]!);
    expect((await stat(join(importRoot, "shared-artifacts"))).isDirectory()).toBe(true);
    await expect(readFile(join(importRoot, "shared-conversation.json"), "utf8")).resolves.toContain(
      "formatVersion",
    );
  });

  // Bug 回归（CR-03）：importIndexWriteChain 原来不 catch，首个写入失败后链条永久
  // rejected，之后每一次 persistCompletedImportIndex 都变成静默 no-op，导入索引永久
  // 丢失且没有自愈路径（marker 成功即删），再导入同一 share 会永久报 already in progress。
  it("索引写入失败一次后不会永久毒化写入链", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-index-chain-"));
    roots.push(root);
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = new ConversationShareHttpClient({
      apiClient,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const rows = [
      {
        rowId: 1,
        turnId: "turn-1",
        entityId: "entity-1",
        productTurnId: "product-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "turnHeader" as const,
        origin: "userInput" as const,
        state: "completedSuccess" as const,
        startedAt: 1,
        endedAt: 2,
      },
    ];
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      zcodeSessionService: {
        createSession: vi.fn(async () => ({ session: { sessionId: "imported-session" } })) as never,
        listSessions: vi.fn(async () => []),
      },
      artifactSource: {
        read: async () => {
          throw new Error("unexpected artifact read");
        },
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(async () => ({
          rows,
          atSeq: 1,
          atRevision: 1,
          atLogEpoch: "epoch",
          hasMore: false,
        })),
        conversationFileChangesV4: vi.fn(),
      },
    });
    const publishShare = async (suffix: string) =>
      service.publish(
        {
          workspacePath: root,
          sessionId: `session-${suffix}`,
          title: `Shared ${suffix}`,
          accessMode: "public_importable",
          selection: { kind: "all" },
          clientRequestId: `publish-index-${suffix}`,
          disclosureAcceptedAt: 9_000,
        },
        `publish-op-index-${suffix}`,
      );

    // 用真实文件系统冲突让 rename 失败：索引路径先被一个非空目录占住。
    const indexPath = join(root, ".zcode-share-imports.json");
    await mkdir(indexPath, { recursive: true });
    await writeFile(join(indexPath, "blocker"), "blocked", "utf8");

    const firstShare = await publishShare("a");
    await service.importShare(
      { shareCode: firstShare.share_code, clientRequestId: "import-index-a" },
      "operation-index-a",
    );
    await expect(readFile(indexPath, "utf8")).rejects.toThrow();

    await rm(indexPath, { recursive: true, force: true });

    const secondShare = await publishShare("b");
    await service.importShare(
      { shareCode: secondShare.share_code, clientRequestId: "import-index-b" },
      "operation-index-b",
    );

    // 链条恢复后索引必须真的落盘，且两次导入都在里面。
    const persisted = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
    const keys = Object.keys(persisted);
    expect(keys.some((key) => key.startsWith(firstShare.share_code))).toBe(true);
    expect(keys.some((key) => key.startsWith(secondShare.share_code))).toBe(true);
  });

  /**
   * 跨版本导入：分享由比本端更新的 Desktop 发布。
   *
   * 这是本次加固前会硬失败的场景——row 上多一个 optional 字段就足以让本端重算出不同的
   * projection_sha256，报「分享文件校验失败，已停止导入」并给一个永远不会成功的重试按钮。
   */
  it("导入更新版本发布的分享：未知字段不破坏完整性，未知 row kind 只被跳过", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-import-future-"));
    roots.push(root);
    // 一行带未来才有的 optional 字段，一行是本端完全不认识的 kind。
    const rawRows = [
      {
        rowId: 1,
        turnId: "turn-1",
        productTurnId: "product-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: 1,
        endedAt: 2,
      },
      {
        rowId: 2,
        turnId: "turn-1",
        productTurnId: "product-1",
        createdAt: 2,
        createdAtSeq: 2,
        kind: "userInput",
        origin: "realUser",
        text: "Continue this work",
        futureFieldAddedLater: "ignored by this build",
      },
      {
        rowId: 3,
        turnId: "turn-1",
        productTurnId: "product-1",
        createdAt: 3,
        createdAtSeq: 3,
        kind: "videoClipAddedLater",
        someFutureShape: { durationMs: 1_000 },
      },
    ];
    const continuation = {
      schema_version: 1,
      import_grant_id: "grant-future",
      import_grant_expires_at: 99_000,
      share: {
        share_id: "share-future",
        title: "Future Share",
        access_mode: "public_importable",
        created_at: 1,
        expires_at: 99_000,
      },
      rows: rawRows,
      artifacts: [],
      // 服务端按原始字节算摘要，本端必须能对得上。
      integrity: {
        projection_sha256: sha256ConversationShareJson(rawRows),
        artifact_set_sha256: sha256ConversationShareJson([]),
      },
      // 服务端将来新增的顶层字段
      viewCountAddedLater: 7,
    };
    const client = new ConversationShareHttpClient({
      apiClient: {
        request: async (url: string | URL) => {
          if (!String(url).endsWith("/continuation")) {
            throw new Error(`unexpected request: ${String(url)}`);
          }
          return new Response(JSON.stringify({ code: 0, msg: "", data: continuation }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      } as never,
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "owner",
    });
    const createSession = vi.fn(async () => ({ session: { sessionId: "imported-future" } }));
    const service = new ConversationShareService({
      client,
      conversationWorkspaceRoot: root,
      zcodeSessionService: { createSession: createSession as never, listSessions: async () => [] },
      artifactSource: {
        read: async () => {
          throw new Error("unexpected artifact read");
        },
      },
      zcodeAgentService: {
        conversationRowsRangeV4: vi.fn(),
        conversationFileChangesV4: vi.fn(),
      },
    });

    const imported = await service.importShare(
      { shareCode: "share-future", clientRequestId: "import-future" },
      "operation-future",
    );

    // 导入必须成功——这正是以前会挂的地方。
    expect(imported.sessionId).toBe("imported-future");

    const loaded = await service.getImportedConversation({
      workspacePath: imported.workspacePath,
      contextId: imported.contextId,
    });
    // 认得的两行照常呈现，认不出的那行被跳过并计数（UI 据此出软提示）。
    expect(loaded?.rows.map((row) => row.kind)).toEqual(["turnHeader", "userInput"]);
    expect(loaded?.unsupportedRowCount).toBe(1);

    // 落盘副本保存原始 rows：用户升级之后能看到当时认不出的内容，不被永久抹掉。
    const shareDirs = await readdir(join(imported.workspacePath, ".zcode-share"));
    const persistedCopy = JSON.parse(
      await readFile(
        join(imported.workspacePath, ".zcode-share", shareDirs[0]!, "shared-conversation.json"),
        "utf8",
      ),
    ) as { rows: unknown[] };
    expect(persistedCopy.rows).toEqual(rawRows);
  });
});
