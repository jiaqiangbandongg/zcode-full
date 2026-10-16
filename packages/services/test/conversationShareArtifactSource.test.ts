import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "../src/conversation-share/conversationShareArtifactSource.js";

const temporaryDirectories: string[] = [];

// Windows 无开发者模式时创建 symlink 会 EPERM；symlink 边界断言按能力探测跳过
const canCreateSymlink = await (async () => {
  const probeRoot = await mkdtemp(join(tmpdir(), "zcode-symlink-probe-"));
  try {
    await symlink(probeRoot, join(probeRoot, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probeRoot, { force: true, recursive: true });
  }
})();

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("conversation share local artifact source", () => {
  it("SHARE06：异步读取 workspace 内文件并执行大小上限", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-artifact-"));
    temporaryDirectories.push(root);
    const path = join(root, "report.pdf");
    await writeFile(path, "pdf!");
    const source = createLocalConversationShareArtifactSource();

    await expect(source.read({ workspacePath: root, ref: path, maxBytes: 4 })).resolves.toEqual({
      bytes: new TextEncoder().encode("pdf!"),
      canonicalPath: await realpath(path),
    });
    await expect(
      source.read({ workspacePath: root, ref: path, maxBytes: 3 }),
    ).rejects.toMatchObject({ kind: "limit_exceeded" });
    await expect(source.stat({ workspacePath: root, ref: path })).resolves.toEqual({
      canonicalPath: await realpath(path),
      size: 4,
      mtimeMs: expect.any(Number),
    });
  });

  it("SHARE06：拒绝 workspace 外路径和指向外部的符号链接", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zcode-share-boundary-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "workspace");
    await mkdir(root);
    const outside = join(parent, "outside.pdf");
    await writeFile(outside, "secret");
    const source = createLocalConversationShareArtifactSource();

    await expect(
      source.read({ workspacePath: root, ref: outside, maxBytes: 100 }),
    ).rejects.toMatchObject({ kind: "unsafe_structure" });
    if (!canCreateSymlink) {
      return;
    }
    const link = join(root, "linked.pdf");
    await symlink(outside, link);
    await expect(
      source.read({ workspacePath: root, ref: link, maxBytes: 100 }),
    ).rejects.toMatchObject({ kind: "unsafe_structure" });
  });

  it("缺失文件报 artifact_read_failed 并保留 errno 与 cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-missing-"));
    temporaryDirectories.push(root);
    const source = createLocalConversationShareArtifactSource();

    // 正文里的模板占位符会走到这里；调用方靠 reasonCode 决定跳过而不是打死整次发布。
    await expect(
      source.read({ workspacePath: root, ref: join(root, "报告.pdf"), maxBytes: 100 }),
    ).rejects.toMatchObject({
      kind: "invalid_conversation",
      reasonCode: "artifact_read_failed",
      diagnostics: { errno: "ENOENT" },
      cause: { code: "ENOENT" },
    });
  });

  it("目录形状的引用报 artifact_read_failed 而非崩溃", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-dir-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "report.pdf"));
    const source = createLocalConversationShareArtifactSource();

    await expect(
      source.read({ workspacePath: root, ref: join(root, "report.pdf"), maxBytes: 100 }),
    ).rejects.toMatchObject({ reasonCode: "artifact_read_failed" });
  });

  it("metadata stat 对缺失文件返回可分类的 artifact_read_failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-share-stat-missing-"));
    temporaryDirectories.push(root);
    const source = createLocalConversationShareArtifactSource();

    await expect(
      source.stat({ workspacePath: root, ref: join(root, "不存在.pdf") }),
    ).rejects.toMatchObject({
      kind: "invalid_conversation",
      reasonCode: "artifact_read_failed",
      diagnostics: { errno: "ENOENT" },
    });
  });
});

describe("conversation share remote artifact source", () => {
  it("远端连接错误不应被伪装成可跳过的文件读取失败", async () => {
    const source = createRemoteConversationShareArtifactSource({
      resolvePath: async ({ path }) => path,
      stat: async () => {
        throw new Error("remote connection closed");
      },
      readFileRange: vi.fn(),
    });

    await expect(
      source.read({ workspacePath: "/workspace", ref: "report.pdf", maxBytes: 100 }),
    ).rejects.toThrow("remote connection closed");
  });

  it("按 range 分块读取远端文件并保留远端 canonical path", async () => {
    const content = new TextEncoder().encode("remote-report");
    const readFileRange = async ({ offset, length }: { offset: number; length: number }) =>
      content.slice(offset, offset + length);
    const source = createRemoteConversationShareArtifactSource({
      resolvePath: async ({ path }) => path.replace("/alias", "/workspace"),
      stat: async ({ path }) => ({
        path,
        type: "file" as const,
        size: content.byteLength,
        mtimeMs: 7,
      }),
      readFileRange,
    });

    await expect(
      source.read({ workspacePath: "/alias", ref: "report.pdf", maxBytes: 100 }),
    ).resolves.toEqual({ bytes: content, canonicalPath: "/workspace/report.pdf" });
  });

  it("拒绝越界路径、空 chunk 和读取期间变化", async () => {
    const base = {
      resolvePath: async ({ path }: { path: string }) => path,
      stat: async ({ path }: { path: string }) => ({
        path,
        type: "file" as const,
        size: 4,
        mtimeMs: 1,
      }),
    };
    await expect(
      createRemoteConversationShareArtifactSource({
        ...base,
        readFileRange: async () => new Uint8Array([1]),
      }).read({ workspacePath: "/workspace", ref: "/outside/report.pdf", maxBytes: 10 }),
    ).rejects.toMatchObject({ kind: "unsafe_structure" });

    await expect(
      createRemoteConversationShareArtifactSource({
        ...base,
        readFileRange: async () => new Uint8Array(0),
      }).read({ workspacePath: "/workspace", ref: "report.pdf", maxBytes: 10 }),
    ).rejects.toMatchObject({ kind: "invalid_conversation" });

    let statCalls = 0;
    await expect(
      createRemoteConversationShareArtifactSource({
        resolvePath: base.resolvePath,
        stat: async ({ path }) => ({
          path,
          type: "file" as const,
          size: 4,
          mtimeMs: ++statCalls,
        }),
        readFileRange: async () => new Uint8Array([1, 2, 3, 4]),
      }).read({ workspacePath: "/workspace", ref: "report.pdf", maxBytes: 10 }),
    ).rejects.toMatchObject({ kind: "invalid_conversation" });

    await expect(
      createRemoteConversationShareArtifactSource({
        ...base,
        stat: async ({ path }) => ({ path, type: "file" as const, size: 4, mtimeMs: 9 }),
        readFileRange: async () => new Uint8Array([1, 2, 3, 4]),
      }).stat({ workspacePath: "/workspace", ref: "report.pdf" }),
    ).resolves.toEqual({ canonicalPath: "/workspace/report.pdf", size: 4, mtimeMs: 9 });
  });
});
