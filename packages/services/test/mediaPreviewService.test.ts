import { describe, expect, it, vi } from "vitest";
import { createMediaPreviewService } from "../src/media-preview/mediaPreview.js";
import type { IFileService } from "../src/file/file.js";

function createFileService(overrides: Partial<IFileService> = {}): IFileService {
  return {
    readdir: vi.fn(),
    stat: vi.fn(async () => ({ path: "/workspace/song.mp3", type: "file", size: 3 })),
    checkFilesExist: vi.fn(),
    resolvePath: vi.fn(),
    ensureConversationWorkspace: vi.fn(),
    createDefaultWorkspace: vi.fn(),
    createScratchWorkspace: vi.fn(),
    readTextFile: vi.fn(),
    readMediaPreview: vi.fn(async ({ path }) => ({
      path,
      mediaType: "audio/mpeg",
      dataBase64: "AQID",
      totalBytes: 3,
    })),
    readFileRange: vi.fn(),
    readBinaryPreview: vi.fn(),
    listWorkspaceFiles: vi.fn(),
    ...overrides,
  } as unknown as IFileService;
}

describe("media preview service", () => {
  it("authorizes local files before returning a playable URL", async () => {
    const fileService = createFileService();
    const authorize = vi.fn(async () => "/canonical/song.mp3");
    const service = createMediaPreviewService({
      fileService,
      authorizeLocalMediaPreviewPath: authorize,
      createLocalMediaPreviewUrl: (path) => `zcode-media://local/preview?path=${path}`,
    });

    await expect(
      service.prepare({ path: "/workspace/song.mp3", expectedKind: "audio" }),
    ).resolves.toEqual({
      kind: "local-url",
      mediaType: "audio/mpeg",
      path: "/canonical/song.mp3",
      size: 3,
      url: "zcode-media://local/preview?path=/canonical/song.mp3",
    });
    expect(authorize).toHaveBeenCalledWith("/workspace/song.mp3");
    expect(fileService.readMediaPreview).not.toHaveBeenCalled();
  });

  it("uses bounded inline bytes for non-local media services", async () => {
    const fileService = createFileService();
    const service = createMediaPreviewService({ fileService, inlineMaxBytes: 8 });

    await expect(
      service.prepare({ path: "/workspace/song.mp3", expectedKind: "audio" }),
    ).resolves.toEqual({
      kind: "inline",
      dataBase64: "AQID",
      mediaType: "audio/mpeg",
      path: "/workspace/song.mp3",
      size: 3,
    });
    expect(fileService.readMediaPreview).toHaveBeenCalledWith({
      path: "/workspace/song.mp3",
      maxBytes: 8,
    });
  });

  it("rejects oversized non-local media without attempting a remote upload", async () => {
    const fileService = createFileService({
      stat: vi.fn(async () => ({ path: "/workspace/movie.mp4", type: "file", size: 9 })),
    });
    const service = createMediaPreviewService({ fileService, inlineMaxBytes: 8 });

    await expect(
      service.prepare({ path: "/workspace/movie.mp4", expectedKind: "video" }),
    ).rejects.toThrow(/too large for inline preview/);
    expect(fileService.readMediaPreview).not.toHaveBeenCalled();
  });

  it("rejects a kind mismatch before reading media bytes", async () => {
    const fileService = createFileService();
    const service = createMediaPreviewService({ fileService });

    await expect(
      service.prepare({ path: "/workspace/song.mp3", expectedKind: "video" }),
    ).rejects.toThrow(/Unsupported media preview format/);
    expect(fileService.stat).not.toHaveBeenCalled();
  });
});
