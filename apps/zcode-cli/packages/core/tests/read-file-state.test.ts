import { describe, expect, it } from "vitest";
import {
  createReadFileStatePathKey,
  findEditableReadFileState,
  findStrictFullReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

describe("read file state path keys", () => {
  it("treats equivalent Windows drive-letter paths as the same read-state file", () => {
    expect(createReadFileStatePathKey("c:/zcode-readwrite-repro/repro.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\zcode-readwrite-repro\\repro.txt", "win32"),
    );
  });

  it("normalizes Windows extended drive prefixes before comparing read-state files", () => {
    expect(createReadFileStatePathKey("\\\\?\\c:\\Repo\\File.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("preserves non-drive Windows device namespace paths", () => {
    expect(createReadFileStatePathKey("\\\\?\\Volume{123}\\Repo\\File.txt", "win32")).toBe(
      "\\\\?\\Volume{123}\\Repo\\File.txt",
    );
    expect(
      createReadFileStatePathKey(
        "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\File.txt",
        "win32",
      ),
    ).toBe("\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\File.txt");
  });

  it("normalizes Windows POSIX drive aliases", () => {
    expect(createReadFileStatePathKey("/c/Repo/File.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("does not normalize cygdrive aliases outside the read-state path key", () => {
    expect(createReadFileStatePathKey("/cygdrive/c/Repo/File.txt", "win32")).not.toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("keeps cygdrive alias casing strict", () => {
    expect(createReadFileStatePathKey("/Cygdrive/c/Repo/File.txt", "win32")).not.toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("does not case-fold Windows path segments without a canonical filesystem identity", () => {
    expect(createReadFileStatePathKey("C:\\Repo\\File.txt", "win32")).not.toBe(
      createReadFileStatePathKey("C:\\repo\\File.txt", "win32"),
    );
  });

  it("does not case-fold non-Windows paths", () => {
    expect(createReadFileStatePathKey("/tmp/ZCode/File.txt", "linux")).not.toBe(
      createReadFileStatePathKey("/tmp/zcode/file.txt", "linux"),
    );
  });

  it("Unicode-normalizes paths on all platforms", () => {
    expect(createReadFileStatePathKey("/tmp/\u00e9.txt", "linux")).toBe(
      createReadFileStatePathKey("/tmp/e\u0301.txt", "linux"),
    );
  });
});

describe("read file state lookup", () => {
  it("uses the newest same-file entry for Edit freshness", () => {
    const file = "/tmp/latest.txt";
    const olderFull = createEntry(file, "old", {
      isPartialView: false,
      readAt: new Date(1),
    });
    const newerPartial = createEntry(file, "new slice", {
      isPartialView: true,
      limit: 1,
      readAt: new Date(2),
    });
    const state: ReadFileStateMap = new Map([
      ["older", olderFull],
      ["newer", newerPartial],
    ]);

    expect(findEditableReadFileState(state, file, "linux")).toBe(newerPartial);
  });

  it("keeps Write on the newest strict full read only", () => {
    const file = "/tmp/full-only.txt";
    const olderFull = createEntry(file, "old", {
      isPartialView: false,
      readAt: new Date(1),
    });
    const newerPartial = createEntry(file, "new slice", {
      isPartialView: true,
      limit: 1,
      readAt: new Date(2),
    });
    const state: ReadFileStateMap = new Map([
      ["older", olderFull],
      ["newer", newerPartial],
    ]);

    expect(findStrictFullReadFileState(state, file, "linux")).toBe(olderFull);
  });

  it("normalizes mtime to integer milliseconds", () => {
    expect(normalizeReadFileStateMtimeMs(123.987)).toBe(123);
    expect(normalizeReadFileStateMtimeMs(undefined)).toBeUndefined();
  });
});

function createEntry(
  filePath: string,
  content: string,
  options: {
    isPartialView: boolean;
    limit?: number;
    readAt: Date;
  },
) {
  return {
    path: filePath,
    content,
    offset: undefined,
    limit: options.limit,
    isPartialView: options.isPartialView,
    readAt: options.readAt,
    revisionId: `rev:${content.length}`,
    mtimeMs: 1,
    sizeBytes: content.length,
  };
}
