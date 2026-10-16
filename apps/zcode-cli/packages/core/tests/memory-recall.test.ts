import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFileSystemError,
  createModelId,
  createModelProviderId,
  type FileSystemListDirectoryEntry,
  type FileSystemPort,
  type Model,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";

import {
  MEMORY_RECALL_SESSION_CHARACTER_LIMIT,
  buildMemorySelectorRequest,
  canStartMemoryRecall,
  createMemoryRecallState,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  formatMemoryManifest,
  formatRelevantMemoryAttachment,
  getMemoryRecallManifest,
  isMemoryRecallQueryEligible,
  readRecalledMemories,
  recordRecalledMemories,
  runMemorySelector,
  scanMemoryManifest,
  type MemoryManifestEntry,
} from "../src/memory/recall/index.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";
import { createTestModelFormatProperties } from "./test-runtime-model.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MEMORY_ROOT = "/storage/memory";
const DAY_MS = 86_400_000;

describe("Semantic Memory manifest", () => {
  it("recursively scans lowercase Markdown, keeps malformed frontmatter metadata-less, and does not follow directory symlinks", async () => {
    const fileSystem = new RecallFileSystem({
      [`${MEMORY_ROOT}/MEMORY.md`]: file("index", 90),
      [`${MEMORY_ROOT}/UPPER.MD`]: file("uppercase", 80),
      [`${MEMORY_ROOT}/broken.md`]: file("---\ndescription: [\n---\nbody", 70),
      [`${MEMORY_ROOT}/incomplete.md`]: file("---\ndescription: unfinished\nbody", 65),
      [`${MEMORY_ROOT}/linked.md`]: file("linked body", 60, "symlink"),
      [`${MEMORY_ROOT}/nested/project-policy.md`]: file(
        [
          "---",
          "name: project-policy",
          "description: Keep the provider request stable.",
          "metadata:",
          "  type: project",
          "---",
          "",
          "project body",
        ].join("\n"),
        50,
      ),
      [`${MEMORY_ROOT}/plain.md`]: file("plain body", 40),
      [`${MEMORY_ROOT}/linked-dir`]: directory(30, "symlink"),
    });

    const manifest = await scanMemoryManifest({
      fileSystem,
      rootDir: MEMORY_ROOT,
    });

    expect(manifest.map((entry) => entry.filename)).toEqual([
      "broken.md",
      "incomplete.md",
      "linked.md",
      "nested/project-policy.md",
      "plain.md",
    ]);
    expect(manifest[0]).toEqual({
      filePath: `${MEMORY_ROOT}/broken.md`,
      filename: "broken.md",
      mtimeMs: 70,
    });
    expect(manifest[1]).toEqual({
      filePath: `${MEMORY_ROOT}/incomplete.md`,
      filename: "incomplete.md",
      mtimeMs: 65,
    });
    expect(manifest[3]).toMatchObject({
      description: "Keep the provider request stable.",
      type: "project",
    });
    expect(fileSystem.listRequests).not.toContain(`${MEMORY_ROOT}/linked-dir`);
    expect(fileSystem.rangeRequests).toEqual(
      expect.arrayContaining([
        { limitLines: 30, path: `${MEMORY_ROOT}/linked.md` },
        { limitLines: 30, path: `${MEMORY_ROOT}/nested/project-policy.md` },
        { limitLines: 30, path: `${MEMORY_ROOT}/plain.md` },
      ]),
    );
  });

  it("sorts by descending mtime and caps the manifest at 200 files", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [
        `${MEMORY_ROOT}/memory-${String(index).padStart(3, "0")}.md`,
        file(`memory ${index}`, index),
      ]),
    );

    const manifest = await scanMemoryManifest({
      fileSystem: new RecallFileSystem(files),
      rootDir: MEMORY_ROOT,
    });

    expect(manifest).toHaveLength(200);
    expect(manifest[0]?.mtimeMs).toBe(204);
    expect(manifest.at(-1)?.mtimeMs).toBe(5);
  });

  it("keeps a non-empty manifest sticky but rescans an empty manifest", async () => {
    const state = createMemoryRecallState();
    const fileSystem = new RecallFileSystem({
      [`${MEMORY_ROOT}/first.md`]: file("first", 1),
    });

    const first = await getMemoryRecallManifest({ fileSystem, rootDir: MEMORY_ROOT, state });
    fileSystem.files[`${MEMORY_ROOT}/second.md`] = file("second", 2);
    const sticky = await getMemoryRecallManifest({ fileSystem, rootDir: MEMORY_ROOT, state });
    expect(sticky).toBe(first);
    expect(sticky.map((entry) => entry.filename)).toEqual(["first.md"]);

    const emptyState = createMemoryRecallState();
    const initiallyEmpty = new RecallFileSystem({});
    expect(
      await getMemoryRecallManifest({
        fileSystem: initiallyEmpty,
        rootDir: MEMORY_ROOT,
        state: emptyState,
      }),
    ).toEqual([]);
    initiallyEmpty.files[`${MEMORY_ROOT}/later.md`] = file("later", 3);
    expect(
      await getMemoryRecallManifest({
        fileSystem: initiallyEmpty,
        rootDir: MEMORY_ROOT,
        state: emptyState,
      }),
    ).toHaveLength(1);
    expect(initiallyEmpty.listRequests.filter((path) => path === MEMORY_ROOT)).toHaveLength(2);
  });

  it("does not cache a partial manifest when the scan is aborted", async () => {
    const abortController = new AbortController();
    const state = createMemoryRecallState();
    const fileSystem = new AbortDuringManifestFileSystem(
      {
        [`${MEMORY_ROOT}/first.md`]: file("first", 2),
        [`${MEMORY_ROOT}/second.md`]: file("second", 1),
      },
      abortController,
    );

    await expect(
      getMemoryRecallManifest({
        fileSystem,
        rootDir: MEMORY_ROOT,
        signal: abortController.signal,
        state,
      }),
    ).resolves.toEqual([]);
    expect(state.manifest).toBeUndefined();
    expect(state.selectorMessages).toBeUndefined();
  });
});

describe("Semantic Memory selector", () => {
  it("builds the frozen Lite selector request with sticky conversation and structured output", () => {
    const fixture = JSON.parse(
      readFileSync(join(TEST_DIR, "fixtures/memory/selector-request.json"), "utf8"),
    ) as SelectorFixture;
    const timestamp = "2026-07-16T00:00:00.000Z";
    const manifest = [
      manifestEntry("database-test-policy.md", {
        description: "Database tests must use the real database rather than mocks.",
        mtimeMs: Date.parse(timestamp),
        type: "feedback",
      }),
    ];
    const state = createMemoryRecallState();
    state.manifest = manifest;
    state.selectorMessages = [
      {
        role: "user",
        content: `Available memories:\n${formatMemoryManifest(manifest)}`,
        cacheControl: { type: "ephemeral" },
      },
    ];

    const request = buildMemorySelectorRequest({
      query: "What database testing approach should I use for this repository?",
      state,
    });

    expect(request.options).toBeUndefined();
    expect(request.responseJsonSchema).toEqual(fixture.output_config.format.schema);
    expect(request.messages[0]).toEqual({
      role: "system",
      content: fixture.system[0]?.text,
      cacheControl: { type: "ephemeral" },
    });
    expect(request.messages.slice(1)).toEqual(
      fixture.messages.map((message) => ({
        role: message.role,
        content: message.content[0]?.text.replace("<TIMESTAMP>", timestamp),
        cacheControl: { type: "ephemeral" },
      })),
    );
  });

  it("returns an empty selection for errors or invalid JSON and only extends conversation after a valid response", async () => {
    const state = selectorState([manifestEntry("known.md")]);
    const model = textModel('{"selected_memories":["known.md","known.md"]}');
    const valid = await runMemorySelector({
      model,
      query: "show known memory",
      state,
    });
    expect(valid).toEqual({ selectedKnowledgeIds: [], selectedMemories: ["known.md", "known.md"] });
    expect(state.selectorMessages).toHaveLength(3);

    const invalidState = selectorState([manifestEntry("known.md")]);
    expect(
      await runMemorySelector({
        model: textModel("not json"),
        query: "show known memory",
        state: invalidState,
      }),
    ).toEqual({ selectedKnowledgeIds: [], selectedMemories: [] });
    expect(invalidState.selectorMessages).toHaveLength(1);

    expect(
      await runMemorySelector({
        model: throwingModel(),
        query: "show known memory",
        state: selectorState([manifestEntry("known.md")]),
      }),
    ).toEqual({ selectedKnowledgeIds: [], selectedMemories: [] });
  });

  it("requests the lowest reasoning level only for the selector without changing Model options", async () => {
    let capturedOptions: Model["options"] | undefined;
    const baseModel = testModel({
      async generateText(request) {
        capturedOptions = request.options;
        return {
          finishReason: "stop",
          model: testModelSelection(),
          text: '{"selected_memories":[]}',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      async *streamText() {},
    });
    const model: Model = {
      ...baseModel,
      optionSpecs: {
        ...baseModel.optionSpecs,
        reasoningLevel: {
          values: ["low", "high"],
        },
      },
      options: { ...baseModel.options, reasoningLevel: "high" },
    };

    await runMemorySelector({
      model,
      query: "show known memory",
      state: selectorState([manifestEntry("known.md")]),
    });

    expect(model.options).toEqual({ maxOutputTokens: 32_000, reasoningLevel: "high" });
    expect(capturedOptions).toEqual({
      maxOutputTokens: 5_000,
      reasoningLevel: "low",
    });
  });

  it("uses the disabled baseline for a selector Model without reasoning", async () => {
    let capturedOptions: Model["options"] | undefined;
    const model = testModel({
      async generateText(request) {
        capturedOptions = request.options;
        return {
          finishReason: "stop",
          model: testModelSelection(),
          text: '{"selected_memories":[]}',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      async *streamText() {},
    });

    await runMemorySelector({
      model,
      query: "show known memory",
      state: selectorState([manifestEntry("known.md")]),
    });

    expect(model.options).toEqual({ maxOutputTokens: 32_000, reasoningLevel: "disabled" });
    expect(capturedOptions).toEqual({
      maxOutputTokens: 5_000,
      reasoningLevel: "disabled",
    });
  });

  it("discards a valid selector response that arrives after abort", async () => {
    const abortController = new AbortController();
    const state = selectorState([manifestEntry("known.md")]);
    const result = await runMemorySelector({
      abortSignal: abortController.signal,
      model: testModel({
        async generateText(_request) {
          abortController.abort();
          return {
            finishReason: "stop",
            model: testModelSelection(),
            text: '{"selected_memories":["known.md"]}',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
        async *streamText() {},
      }),
      query: "show known memory",
      state,
    });

    expect(result).toEqual({ selectedKnowledgeIds: [], selectedMemories: [] });
    expect(state.selectorMessages).toHaveLength(1);
  });

  it("does not call the selector when every sticky manifest path was already recalled", async () => {
    const state = selectorState([manifestEntry("known.md")]);
    state.recalledPaths.add(`${MEMORY_ROOT}/known.md`);
    let callCount = 0;
    const model = textModel('{"selected_memories":[]}', () => callCount++);

    expect(
      await runMemorySelector({
        model,
        query: "show known memory",
        state,
      }),
    ).toEqual({ selectedKnowledgeIds: [], selectedMemories: [] });
    expect(callCount).toBe(0);
    expect(state.selectorMessages).toHaveLength(1);

    const emptyState = createMemoryRecallState();
    await runMemorySelector({
      model,
      query: "show known memory",
      state: emptyState,
    });
    expect(callCount).toBe(0);
  });

  it("uses the latest non-meta user text and requires whitespace after trimming", () => {
    const query = findLatestMemoryRecallQuery([
      { message: { role: "user", content: "older query" }, metadata: { source: "real_user" } },
      { kind: "attachment", content: "internal", metadata: { source: "relevant_memory" } },
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "latest query with spaces" }],
        },
        metadata: { source: "real_user" },
      },
    ]);

    expect(query).toBe("latest query with spaces");
    expect(isMemoryRecallQueryEligible(query)).toBe(true);
    expect(isMemoryRecallQueryEligible("singleword")).toBe(false);
    expect(isMemoryRecallQueryEligible("\t singleword \n")).toBe(false);
    expect(isMemoryRecallQueryEligible("中文问题")).toBe(false);
  });

  it("treats explicit real_user metadata as authoritative over literal reminder text", () => {
    expect(
      findLatestMemoryRecallQuery([
        {
          message: { role: "user", content: "older real query" },
          metadata: { source: "real_user" },
        },
        {
          message: {
            role: "user",
            content: "<system-reminder>\nliteral user text\n</system-reminder>",
          },
          metadata: { source: "real_user" },
        },
      ]),
    ).toBe("<system-reminder>\nliteral user text\n</system-reminder>");
  });

  it("uses the reminder-text heuristic only for metadata-less legacy messages", () => {
    expect(
      findLatestMemoryRecallQuery([
        {
          message: { role: "user", content: "older real query" },
          metadata: { source: "real_user" },
        },
        { message: { role: "user", content: "<system-reminder>legacy meta</system-reminder>" } },
      ]),
    ).toBe("older real query");
  });
});

describe("Semantic Memory selection and content", () => {
  it("preserves order and duplicates while filtering unknown, previously read, and recalled paths before the five-item cap", () => {
    const manifest = Array.from({ length: 8 }, (_, index) => manifestEntry(`memory-${index}.md`));
    const readFileState: ReadFileStateMap = new Map();
    const readEntry = manifest[1]!;
    readFileState.set(createReadFileStateKey(readEntry.filePath, 1, undefined), {
      content: "read",
      isPartialView: false,
      path: readEntry.filePath,
      readAt: new Date(),
    });

    const selected = filterMemorySelections({
      manifest,
      readFileState,
      recalledPaths: new Set([manifest[2]!.filePath]),
      selectedFilenames: [
        "unknown.md",
        "memory-1.md",
        "memory-2.md",
        "memory-0.md",
        "memory-0.md",
        "memory-3.md",
        "memory-4.md",
        "memory-5.md",
        "memory-6.md",
      ],
    });

    expect(selected.map((entry) => entry.filename)).toEqual([
      "memory-0.md",
      "memory-0.md",
      "memory-3.md",
      "memory-4.md",
      "memory-5.md",
    ]);
  });

  it("normalizes BOM and CRLF while preserving the memory frontmatter and body", async () => {
    const path = `${MEMORY_ROOT}/normalized.md`;
    const content = "\uFEFF---\r\nname: normalized\r\n---\r\n\r\nbody\r\n";
    const recalled = await readRecalledMemories({
      entries: [manifestEntry("normalized.md")],
      fileSystem: new RecallFileSystem({ [path]: file(content, 1) }),
      nowMs: 1,
    });

    expect(recalled[0]?.content).toBe("---\nname: normalized\n---\n\nbody\n");
    expect(recalled[0]).toMatchObject({
      limit: undefined,
      revisionId: "revision:/storage/memory/normalized.md:1",
      sizeBytes: Buffer.byteLength(content, "utf8"),
    });
  });

  it("keeps only complete lines and uses the byte truncation reason when both limits apply", async () => {
    const path = `${MEMORY_ROOT}/large.md`;
    const lines = Array.from(
      { length: 220 },
      (_, index) => `${String(index).padStart(3, "0")}:${"x".repeat(24)}`,
    );
    const recalled = await readRecalledMemories({
      entries: [manifestEntry("large.md")],
      fileSystem: new RecallFileSystem({ [path]: file(`${lines.join("\n")}\n`, 1) }),
      nowMs: 1,
    });

    expect(recalled[0]?.content).toContain(
      `> This memory file was truncated (4096 byte limit). Use the Read tool to view the complete file at: ${path}`,
    );
    expect(recalled[0]?.content).not.toContain("first 200 lines");
    const retained = recalled[0]!.content.split("\n\n> This memory file was truncated")[0]!;
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(4096);
    expect(lines).toContain(retained.split("\n").at(-1));
    expect(recalled[0]?.limit).toBe(retained.split("\n").length);
  });

  it("uses the exact line truncation suffix when only the 200-line limit applies", async () => {
    const path = `${MEMORY_ROOT}/many-lines.md`;
    const lines = Array.from({ length: 201 }, (_, index) => String(index));
    const recalled = await readRecalledMemories({
      entries: [manifestEntry("many-lines.md")],
      fileSystem: new RecallFileSystem({ [path]: file(lines.join("\n"), 1) }),
      nowMs: 1,
    });

    expect(
      recalled[0]?.content.endsWith(
        `> This memory file was truncated (first 200 lines). Use the Read tool to view the complete file at: ${path}`,
      ),
    ).toBe(true);
    expect(recalled[0]?.limit).toBe(200);
  });

  it("renders the frozen relevant-memory MCS body and stale warning", async () => {
    const fixture = readFileSync(join(TEST_DIR, "fixtures/memory/recalled-memory.md"), "utf8");
    const path = `${MEMORY_ROOT}/database-test-policy.md`;
    const content = `${[
      "---",
      "name: database-test-policy",
      "description: Database tests must use the real database rather than mocks.",
      "metadata:",
      "  type: feedback",
      "---",
      "",
      "Use the real database for database tests; mocked database tests are not trusted.",
      "",
      "**Why:** A prior mocked test passed while production migration behavior failed.",
      "",
      "**How to apply:** Use the real database for database integration tests.",
    ].join("\n")}\n`;
    const recalled = await readRecalledMemories({
      entries: [manifestEntry("database-test-policy.md", { mtimeMs: 100 })],
      fileSystem: new RecallFileSystem({ [path]: file(content, 100) }),
      nowMs: 100,
    });

    expect(formatRelevantMemoryAttachment(recalled)).toBe(
      fixture.replaceAll("<MEMORY_ROOT>", MEMORY_ROOT),
    );

    const stale = await readRecalledMemories({
      entries: [manifestEntry("database-test-policy.md", { mtimeMs: 100 })],
      fileSystem: new RecallFileSystem({ [path]: file(content, 100) }),
      nowMs: 100 + 3 * DAY_MS,
    });
    expect(stale[0]?.header).toBe(
      `This memory is 3 days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n\nMemory: ${path}:`,
    );

    const notYetStale = await readRecalledMemories({
      entries: [manifestEntry("database-test-policy.md", { mtimeMs: 100 })],
      fileSystem: new RecallFileSystem({ [path]: file(content, 100) }),
      nowMs: 100 + 2 * DAY_MS - 1,
    });
    expect(notYetStale[0]?.header).toBe(`Memory: ${path}:`);

    const oneDayOld = await readRecalledMemories({
      entries: [manifestEntry("database-test-policy.md", { mtimeMs: 100 })],
      fileSystem: new RecallFileSystem({ [path]: file(content, 100) }),
      nowMs: 100 + DAY_MS + 1,
    });
    expect(oneDayOld[0]?.header).toBe(`Memory: ${path}:`);

    const staleAtTwoDays = await readRecalledMemories({
      entries: [manifestEntry("database-test-policy.md", { mtimeMs: 100 })],
      fileSystem: new RecallFileSystem({ [path]: file(content, 100) }),
      nowMs: 100 + 2 * DAY_MS,
    });
    expect(staleAtTwoDays[0]?.header).toContain("This memory is 2 days old.");
  });

  it("tracks recalled paths and JavaScript character count at the 61,440 limit", () => {
    const state = createMemoryRecallState();
    expect(canStartMemoryRecall(state)).toBe(true);
    recordRecalledMemories(state, [
      {
        content: "🙂".repeat(MEMORY_RECALL_SESSION_CHARACTER_LIMIT / 2),
        filePath: `${MEMORY_ROOT}/limit.md`,
        header: "Memory",
        limit: undefined,
        mtimeMs: 1,
        sizeBytes: MEMORY_RECALL_SESSION_CHARACTER_LIMIT * 2,
      },
    ]);
    expect(state.recalledContentCharacters).toBe(MEMORY_RECALL_SESSION_CHARACTER_LIMIT);
    expect(canStartMemoryRecall(state)).toBe(false);
    expect(state.recalledPaths).toEqual(new Set([`${MEMORY_ROOT}/limit.md`]));
  });
});

interface TestNode {
  content?: string;
  kind: "file" | "directory";
  listedKind?: "file" | "directory" | "symlink";
  mtimeMs: number;
}

function file(
  content: string,
  mtimeMs: number,
  listedKind: TestNode["listedKind"] = "file",
): TestNode {
  return { content, kind: "file", listedKind, mtimeMs };
}

function directory(mtimeMs: number, listedKind: TestNode["listedKind"] = "directory"): TestNode {
  return { kind: "directory", listedKind, mtimeMs };
}

class RecallFileSystem implements FileSystemPort {
  readonly listRequests: string[] = [];
  readonly rangeRequests: Array<{ limitLines?: number; path: string }> = [];

  constructor(readonly files: Record<string, TestNode>) {}

  async createDirectory(request: { path: string }) {
    return { path: request.path };
  }

  async stat(request: { path: string }) {
    const node = this.node(request.path);
    return {
      kind: node.kind,
      mtimeMs: node.mtimeMs,
      path: request.path,
      sizeBytes: Buffer.byteLength(node.content ?? "", "utf8"),
    };
  }

  async readTextFile(request: { path: string; encoding?: BufferEncoding; maxBytes?: number }) {
    const node = this.node(request.path);
    if (node.kind !== "file") throw notFile(request.path);
    const source = Buffer.from(node.content ?? "", "utf8");
    const returned =
      request.maxBytes !== undefined && source.byteLength > request.maxBytes
        ? source.subarray(0, request.maxBytes)
        : source;
    const raw = returned.toString("utf8");
    return {
      bytesRead: returned.byteLength,
      content: raw.replace(/\r\n/gu, "\n"),
      encoding: request.encoding ?? "utf8",
      path: request.path,
      sizeBytes: source.byteLength,
      truncated: returned.byteLength < source.byteLength,
    };
  }

  async readBinaryFile(request: { path: string; maxBytes?: number }) {
    const node = this.node(request.path);
    const content = Buffer.from(node.content ?? "", "utf8");
    if (request.maxBytes !== undefined && content.byteLength > request.maxBytes) {
      throw createFileSystemError({
        code: "too_large",
        message: "too large",
        path: request.path,
      });
    }
    return {
      bytesRead: content.byteLength,
      content,
      path: request.path,
      sizeBytes: content.byteLength,
    };
  }

  async readTextFileRange(request: {
    path: string;
    encoding?: BufferEncoding;
    offsetLine?: number;
    limitLines?: number;
  }) {
    this.rangeRequests.push({ limitLines: request.limitLines, path: request.path });
    const node = this.node(request.path);
    if (node.kind !== "file") throw notFile(request.path);
    const source = node.content ?? "";
    const normalized = source.replace(/\r\n/gu, "\n");
    const lines = normalized.split("\n");
    const offset = request.offsetLine ?? 0;
    const selected = lines.slice(
      offset,
      request.limitLines === undefined ? undefined : offset + request.limitLines,
    );
    return {
      bytesRead: Buffer.byteLength(selected.join("\n"), "utf8"),
      content: selected.join("\n"),
      encoding: request.encoding ?? "utf8",
      lineCount: selected.length,
      path: request.path,
      sizeBytes: Buffer.byteLength(source, "utf8"),
      startLine: offset + 1,
      totalLines: lines.length,
      truncated: selected.length < lines.length - offset,
      revision: { id: `revision:${request.path}:${node.mtimeMs}` },
    };
  }

  async writeTextFile(request: { content: string; path: string }) {
    this.files[request.path] = file(request.content, Date.now());
    return { bytesWritten: Buffer.byteLength(request.content), path: request.path };
  }

  async removeFile(request: { missingOk?: boolean; path: string }) {
    const removed = delete this.files[request.path];
    if (!removed && !request.missingOk) throw missing(request.path);
    return { path: request.path, removed };
  }

  async listDirectory(request: { path: string }) {
    this.listRequests.push(request.path);
    if (request.path !== MEMORY_ROOT && this.files[request.path]?.kind !== "directory") {
      const hasChildren = Object.keys(this.files).some((path) =>
        path.startsWith(`${request.path}/`),
      );
      if (!hasChildren) throw missing(request.path);
    }
    const prefix = `${request.path.replace(/\/+$/u, "")}/`;
    const entries = new Map<string, FileSystemListDirectoryEntry>();
    for (const [path, node] of Object.entries(this.files)) {
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      const name = relative.split("/")[0];
      if (!name || entries.has(name)) continue;
      const direct = !relative.includes("/");
      const directNode = direct ? node : this.files[`${prefix}${name}`];
      entries.set(name, {
        kind: directNode?.listedKind ?? (direct ? node.kind : "directory"),
        name,
        path: `${prefix}${name}`,
      });
    }
    const values = [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
    return { durationMs: 0, entries: values, numEntries: values.length, path: request.path };
  }

  async searchFiles(request: { path: string; pattern: string }) {
    return {
      durationMs: 0,
      files: [],
      numFiles: 0,
      path: request.path,
      pattern: request.pattern,
      truncated: false,
    };
  }

  async searchText(request: {
    outputMode?: "content" | "files_with_matches" | "count";
    path: string;
    pattern: string;
  }) {
    return {
      durationMs: 0,
      entries: [],
      files: [],
      mode: request.outputMode ?? "files_with_matches",
      numMatches: 0,
      path: request.path,
      pattern: request.pattern,
      truncated: false,
    };
  }

  private node(path: string): TestNode {
    const direct = this.files[path];
    if (direct) return direct;
    if (Object.keys(this.files).some((candidate) => candidate.startsWith(`${path}/`))) {
      return directory(0);
    }
    throw missing(path);
  }
}

class AbortDuringManifestFileSystem extends RecallFileSystem {
  constructor(
    files: Record<string, TestNode>,
    private readonly abortController: AbortController,
  ) {
    super(files);
  }

  override async readTextFileRange(request: {
    path: string;
    encoding?: BufferEncoding;
    offsetLine?: number;
    limitLines?: number;
  }) {
    if (request.path.endsWith("/second.md")) {
      await Promise.resolve();
      if (this.abortController.signal.aborted) throw this.abortController.signal.reason;
    }
    const result = await super.readTextFileRange(request);
    if (request.path.endsWith("/first.md")) this.abortController.abort();
    return result;
  }
}

function missing(path: string): Error {
  return createFileSystemError({ code: "not_found", message: `missing: ${path}`, path });
}

function notFile(path: string): Error {
  return createFileSystemError({ code: "not_file", message: `not file: ${path}`, path });
}

function manifestEntry(
  filename: string,
  overrides: Partial<MemoryManifestEntry> = {},
): MemoryManifestEntry {
  return {
    filePath: `${MEMORY_ROOT}/${filename}`,
    filename,
    mtimeMs: 1,
    ...overrides,
  };
}

function selectorState(manifest: MemoryManifestEntry[]) {
  const state = createMemoryRecallState();
  state.manifest = manifest;
  state.selectorMessages = [
    {
      role: "user",
      content: `Available memories:\n${formatMemoryManifest(manifest)}`,
      cacheControl: { type: "ephemeral" },
    },
  ];
  return state;
}

function testModelSelection() {
  return {
    providerId: createModelProviderId("test"),
    modelId: createModelId("lite"),
  };
}

function textModel(text: string, onCall?: () => void): Model {
  return testModel({
    async generateText() {
      onCall?.();
      return {
        finishReason: "stop",
        model: testModelSelection(),
        text,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async *streamText() {},
  });
}

function throwingModel(): Model {
  return testModel({
    async generateText() {
      throw new Error("selector failed");
    },
    async *streamText() {},
  });
}

function testModel(executor: Pick<Model, "generateText" | "streamText">): Model {
  return {
    ...testModelSelection(),
    properties: {
      contextWindow: 200_000,
      ...createTestModelFormatProperties(),
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["disabled"] },
      maxOutputTokens: { max: 32_000 },
    },
    options: { maxOutputTokens: 32_000, reasoningLevel: "disabled" },
    bind() {
      return this;
    },
    ...executor,
  };
}

interface SelectorFixture {
  model: string;
  system: Array<{ text: string }>;
  messages: Array<{ role: "user"; content: Array<{ text: string }> }>;
  output_config: { format: { schema: Record<string, unknown> } };
}
