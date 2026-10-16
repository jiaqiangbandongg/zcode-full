import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_MAX_DIMENSION,
  READ_IMAGE_MAX_INPUT_BYTES,
  READ_IMAGE_TARGET_BYTES,
  READ_MAX_OUTPUT_TOKENS,
  createImageProcessorError,
  createFileSystemError,
  type FileSystemLineEndings,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemRevision,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextResult,
  type FileSystemStatResult,
  type FileSystemTextEncoding,
  type FileSystemWriteTextRequest,
  type ImageProcessorPort,
  type ApplyPatchOutput,
} from "@zcode/contracts";
import { globHandler } from "../src/tool/handlers/glob.js";
import { grepHandler } from "../src/tool/handlers/grep.js";
import { readHandler, readToolEntry } from "../src/tool/handlers/read.js";
import { writeHandler } from "../src/tool/handlers/write.js";
import { editHandler } from "../src/tool/handlers/edit.js";
import { applyPatchHandler } from "../src/tool/handlers/apply-patch.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap, ToolExecutionContext } from "../src/tool/types.js";

const workspaceRoot = resolve("/work");
const projectRoot = join(workspaceRoot, "project");
const filePath = join(workspaceRoot, "file.txt");
const projectFilePath = join(projectRoot, "src", "file.txt");
const outsidePath = join(resolve("/tmp"), "outside.txt");

describe("file tool handlers", () => {
  it("reads text through FileSystemPort and applies visible line ranges", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "one\ntwo\nthree\n",
    });

    const output = await readHandler(
      {
        file_path: filePath,
        offset: 1,
        limit: 2,
      },
      contextWith(fs),
    );

    expect(output).toMatchObject({
      type: "text",
      filePath,
      content: "one\ntwo",
      numLines: 2,
      startLine: 1,
      totalLines: 4,
    });
    expect(fs.readPaths).toEqual([filePath]);
  });

  it("rejects large full text reads with the 256KB guard", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: `${"x".repeat(256 * 1024)}\n`,
    });

    await expect(
      readHandler(
        {
          file_path: filePath,
        },
        contextWith(fs),
      ),
    ).rejects.toMatchObject({
      type: "tool_execution_failed",
      message: expect.stringContaining("maximum allowed size (256KB)"),
      context: {
        code: "read_file_too_large",
        filePath,
        maxBytes: 256 * 1024,
      },
    });
  });

  it("returns an error instead of empty-file content when Read targets a missing file", async () => {
    const fs = createMemoryFileSystem({});

    await expect(
      readHandler(
        {
          file_path: filePath,
        },
        contextWith(fs),
      ),
    ).rejects.toMatchObject({
      type: "tool_execution_failed",
      message: expect.stringContaining("File does not exist. Note: your current working directory"),
      context: {
        code: "read_file_not_found",
        filePath,
      },
    });
  });

  it("reads a real later range from a large file when limit is explicit", async () => {
    const content = Array.from(
      { length: 3000 },
      (_, index) => `${index + 1}: ${"x".repeat(120)}`,
    ).join("\n");
    const fs = createMemoryFileSystem({
      [filePath]: content,
    });

    const output = await readHandler(
      {
        file_path: filePath,
        offset: 2500,
        limit: 2,
      },
      contextWith(fs),
    );

    expect(output).toMatchObject({
      type: "text",
      filePath,
      content: `2500: ${"x".repeat(120)}\n2501: ${"x".repeat(120)}`,
      numLines: 2,
      startLine: 2500,
      totalLines: 3000,
    });
  });

  it("rejects selected text ranges that exceed the Read token budget", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "x".repeat(80_000),
    });

    await expect(
      readHandler(
        {
          file_path: filePath,
          limit: 1,
        },
        contextWith(fs),
      ),
    ).rejects.toMatchObject({
      type: "tool_execution_failed",
      message: expect.stringContaining("maximum allowed tokens (25000)"),
      context: {
        code: "read_output_too_many_tokens",
        filePath,
        maxTokens: 25_000,
      },
    });
  });

  it("downgrades initial full text reads to a partial view when they exceed the token budget", async () => {
    const content = Array.from(
      { length: 1800 },
      (_, index) => `${index + 1}: ${"x".repeat(120)}`,
    ).join("\n");
    const fs = createMemoryFileSystem({
      [filePath]: content,
    });

    const output = await readHandler(
      {
        file_path: filePath,
      },
      contextWith(fs),
    );

    expect(output).toMatchObject({
      type: "text",
      filePath,
      startLine: 1,
      totalLines: 1800,
      truncated: true,
      truncatedByTokenCap: true,
    });
    expect(output.numLines).toBeGreaterThan(0);
    expect(output.numLines).toBeLessThan(1800);
    expect(output.partialViewNotice).toContain("partial view");
    expect(output.partialViewNotice).toContain(`offset ${output.numLines + 1}`);

    const modelContent = readToolEntry.formatModelContent?.(output);
    expect(modelContent).toContain("<system-reminder>");
    expect(modelContent).toContain("partial view");
    expect(modelContent).toContain("1\t1:");
  });

  it("returns Read model content that can be copied into Edit without escaped tab drift", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "工作任务\n- [ ] prd auto research 的\n\t- [ ] beta 部分继续",
    });
    const context = contextWith(fs);

    const readOutput = await readHandler(
      {
        file_path: filePath,
      },
      context,
    );

    const modelContent = readToolEntry.formatModelContent?.(readOutput);
    expect(modelContent).toContain("3\t\t- [ ] beta 部分继续");
    expect(modelContent).not.toContain("\\t- [ ] beta 部分继续");

    await expect(
      editHandler(
        {
          file_path: filePath,
          old_string: "- [ ] prd auto research 的\n\t- [ ] beta 部分继续",
          new_string: "- [x] prd auto research 的\n\t- [x] beta 部分继续",
        },
        context,
      ),
    ).resolves.toMatchObject({
      oldString: "- [ ] prd auto research 的\n\t- [ ] beta 部分继续",
      newString: "- [x] prd auto research 的\n\t- [x] beta 部分继续",
    });
    await expect(
      editHandler(
        {
          file_path: filePath,
          old_string: "\\t- [x] beta 部分继续",
          new_string: "\\t- [ ] beta 部分继续",
        },
        context,
      ),
    ).resolves.toMatchObject({
      matchStrategy: "escape_normalized",
      oldString: "\t- [x] beta 部分继续",
      newString: "\t- [ ] beta 部分继续",
    });
    expect(fs.files.get(filePath)).toContain("\t- [ ] beta 部分继续");
  });

  it("reads images through ImageProcessorPort with model image budgets", async () => {
    const imagePath = join(workspaceRoot, "screen.png");
    const fs = createMemoryFileSystem({
      [imagePath]: "image",
    });
    const prepareRequests: Parameters<ImageProcessorPort["prepareForModel"]>[0][] = [];
    const imageProcessorPort: ImageProcessorPort = {
      async resizeToFit() {
        throw new Error("unexpected resizeToFit");
      },
      async prepareForModel(request) {
        prepareRequests.push(request);
        return {
          data: Buffer.from("resized-image"),
          height: 667,
          mediaType: "image/jpeg",
          originalHeight: 1000,
          originalSizeBytes: Buffer.from(request.data).byteLength,
          originalWidth: 3000,
          resized: true,
          compressed: true,
          strategy: "jpeg-quality",
          transformedSizeBytes: 13,
          width: 2000,
        };
      },
    };

    const output = await readHandler(
      {
        file_path: imagePath,
      },
      contextWith(fs, { imageProcessorPort }),
    );

    expect(fs.readPaths).toEqual([imagePath]);
    expect(prepareRequests).toHaveLength(1);
    expect(prepareRequests[0]).toMatchObject({
      maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
      maxDimension: READ_IMAGE_MAX_DIMENSION,
      maxRawBytes: READ_IMAGE_TARGET_BYTES,
      maxTokens: READ_MAX_OUTPUT_TOKENS,
      mediaType: "image/png",
    });
    expect(Buffer.from(prepareRequests[0]!.data).toString("utf8")).toBe("image");
    expect(output).toEqual({
      type: "image",
      base64: "cmVzaXplZC1pbWFnZQ==",
      mimeType: "image/jpeg",
      originalSize: 5,
      transformedSize: 13,
      resized: true,
      compressed: true,
      compressionStrategy: "jpeg-quality",
      dimensions: {
        originalWidth: 3000,
        originalHeight: 1000,
        displayWidth: 2000,
        displayHeight: 667,
      },
    });

    expect(readToolEntry.formatModelContent?.(output)).toEqual([
      {
        type: "image",
        mediaType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,cmVzaXplZC1pbWFnZQ==",
        source: {
          id: "read-image",
          kind: "inline",
          mimeType: "image/jpeg",
          placeholder: "Read image",
          sizeBytes: 5,
        },
      },
    ]);
  });

  it("maps empty image processor failures to a stable Read error code", async () => {
    const imagePath = join(workspaceRoot, "empty.png");
    const fs = createMemoryFileSystem({
      [imagePath]: "",
    });
    const imageProcessorPort: ImageProcessorPort = {
      async resizeToFit(request) {
        throw new Error(`unexpected resizeToFit: ${request.mediaType}`);
      },
      async prepareForModel() {
        throw createImageProcessorError({
          code: "empty",
          message: "Image file is empty (0 bytes)",
        });
      },
    };

    await expect(
      readHandler(
        {
          file_path: imagePath,
        },
        contextWith(fs, { imageProcessorPort }),
      ),
    ).rejects.toMatchObject({
      context: {
        code: "read_image_empty",
        maxInputBytes: READ_IMAGE_MAX_INPUT_BYTES,
      },
      type: "tool_execution_failed",
    });
  });

  it("rejects image inputs before decoding when the raw file exceeds the Read cap", async () => {
    const imagePath = join(workspaceRoot, "huge.png");
    const fs = createMemoryFileSystem({
      [imagePath]: "x".repeat(READ_IMAGE_MAX_INPUT_BYTES + 1),
    });
    const imageProcessorPort: ImageProcessorPort = {
      async resizeToFit(request) {
        throw new Error(`unexpected resizeToFit: ${request.mediaType}`);
      },
      async prepareForModel(request) {
        throw new Error(`unexpected prepareForModel: ${request.mediaType}`);
      },
    };

    await expect(
      readHandler(
        {
          file_path: imagePath,
        },
        contextWith(fs, { imageProcessorPort }),
      ),
    ).rejects.toMatchObject({
      context: {
        code: "read_image_input_too_large",
      },
      type: "tool_execution_failed",
    });
  });

  it("resolves relative file tool paths from the session cwd", async () => {
    const fs = createMemoryFileSystem({
      [projectFilePath]: "old value",
    });
    const readFileState: ReadFileStateMap = new Map();
    const context = contextWith(fs, {
      readFileState,
      workingDirectory: projectRoot,
      workspaceRoot: projectRoot,
    });

    const readOutput = await readHandler(
      {
        file_path: "src/file.txt",
      },
      context,
    );
    const writeOutput = await writeHandler(
      {
        file_path: "src/file.txt",
        content: "new value",
      },
      context,
    );

    expect(readOutput).toMatchObject({
      filePath: projectFilePath,
      content: "old value",
    });
    expect(writeOutput).toMatchObject({
      filePath: "src/file.txt",
      originalFile: "old value",
      type: "update",
    });
    expect(fs.readPaths).toEqual([projectFilePath, projectFilePath]);
    expect(fs.files.get(projectFilePath)).toBe("new value");
  });

  it("allows file tool paths outside the workspace root in the current release", async () => {
    const siblingPath = join(workspaceRoot, "outside.txt");
    const fs = createMemoryFileSystem({
      [outsidePath]: "external value",
    });
    const context = contextWith(fs, {
      workingDirectory: projectRoot,
      workspaceRoot: projectRoot,
    });

    const writeOutput = await writeHandler(
      {
        file_path: "../outside.txt",
        content: "allowed",
      },
      context,
    );
    const readOutput = await readHandler(
      {
        file_path: outsidePath,
      },
      context,
    );

    expect(writeOutput).toMatchObject({
      filePath: "../outside.txt",
      type: "create",
    });
    expect(fs.files.get(siblingPath)).toBe("allowed");
    expect(readOutput).toMatchObject({
      filePath: outsidePath,
      content: "external value",
    });
  });

  it("allows search tool paths outside the workspace root in the current release", async () => {
    const externalRoot = join(resolve("/tmp"), "external-project");
    const externalFile = join(externalRoot, "src", "index.ts");
    const fs = createMemoryFileSystem({
      [externalFile]: "export const answer = 42;",
    });
    const context = contextWith(fs, {
      workingDirectory: projectRoot,
      workspaceRoot: projectRoot,
    });

    const globOutput = await globHandler(
      {
        pattern: "**/*.ts",
        path: externalRoot,
      },
      context,
    );
    const grepOutput = await grepHandler(
      {
        pattern: "answer",
        path: externalRoot,
      },
      context,
    );

    expect(globOutput).toMatchObject({
      filenames: [externalFile],
      numFiles: 1,
    });
    expect(grepOutput).toMatchObject({
      filenames: [externalFile],
      numFiles: 1,
      numMatches: 1,
    });
    expect(fs.lastSearchFiles?.path).toBe(externalRoot);
    expect(fs.lastSearchText?.path).toBe(externalRoot);
  });

  it("finds files through FileSystemPort searchFiles", async () => {
    const fs = createMemoryFileSystem({
      [join(projectRoot, "src", "index.ts")]: "export const answer = 42;",
      [join(projectRoot, "src", "index.test.ts")]: "expect(answer).toBe(42);",
      [join(projectRoot, "README.md")]: "# Project",
    });
    const context = contextWith(fs, {
      workingDirectory: projectRoot,
      workspaceRoot: projectRoot,
    });

    const output = await globHandler(
      {
        pattern: "**/*.ts",
      },
      context,
    );

    expect(output).toMatchObject({
      numFiles: 2,
      filenames: ["src/index.test.ts", "src/index.ts"],
      truncated: false,
    });
    expect(fs.lastSearchFiles?.path).toBe(projectRoot);
    expect(fs.lastSearchFiles?.pattern).toBe("**/*.ts");
  });

  it("searches file contents through FileSystemPort searchText", async () => {
    const fs = createMemoryFileSystem({
      [join(projectRoot, "src", "index.ts")]: "export const answer = 42;\nconsole.log(answer);",
      [join(projectRoot, "src", "other.ts")]: "export const other = true;",
    });
    const context = contextWith(fs, {
      workingDirectory: projectRoot,
      workspaceRoot: projectRoot,
    });

    const filesOutput = await grepHandler(
      {
        pattern: "answer",
        glob: "**/*.ts",
      },
      context,
    );
    const contentOutput = await grepHandler(
      {
        pattern: "answer",
        output_mode: "content",
        "-n": true,
      },
      context,
    );

    expect(filesOutput).toMatchObject({
      mode: "files_with_matches",
      filenames: ["src/index.ts"],
      numFiles: 1,
      numMatches: 2,
      truncated: false,
    });
    expect(contentOutput).toMatchObject({
      mode: "content",
      content: "src/index.ts:1:export const answer = 42;\nsrc/index.ts:2:console.log(answer);",
      numLines: 2,
      numMatches: 2,
    });
    expect(fs.lastSearchText?.pattern).toBe("answer");
    expect(fs.lastSearchText?.glob).toBeUndefined();
  });

  it("maps cancelled Grep searches to tool cancellation", async () => {
    const fs = createMemoryFileSystem({});
    const context = contextWith(fs, {
      workingDirectory: projectRoot,
      workspaceRoot: projectRoot,
    });
    const controller = new AbortController();
    controller.abort();
    const cancelledContext = {
      ...context,
      abortSignal: controller.signal,
    };

    await expect(
      grepHandler(
        {
          pattern: "answer",
        },
        cancelledContext,
      ),
    ).rejects.toMatchObject({
      type: "tool_cancelled",
      message: "Grep was cancelled",
    });
  });

  it("writes text through FileSystemPort and returns the previous contents", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "old",
    });

    const output = await writeHandler(
      {
        file_path: filePath,
        content: "new",
      },
      contextWith(fs, { readFileState: createReadFileState(filePath, "old") }),
    );

    expect(output).toMatchObject({
      type: "update",
      filePath,
      content: "new",
      originalFile: "old",
    });
    expect(output.structuredPatch).toEqual([
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"],
      },
    ]);
    expect(fs.files.get(filePath)).toBe("new");
  });

  it("passes legacy text encoding metadata through Write updates", async () => {
    const fs = createMemoryFileSystem(
      {
        [filePath]: "// 你好\nconst answer = 1;\n",
      },
      { encoding: "gb2312" },
    );

    await writeHandler(
      {
        file_path: filePath,
        content: "// 你好\nconst answer = 2;\n",
      },
      contextWith(fs, {
        readFileState: createReadFileState(filePath, "// 你好\nconst answer = 1;\n"),
      }),
    );

    expect(fs.lastWrite?.encoding).toBe("gb2312");
    expect(fs.files.get(filePath)).toBe("// 你好\nconst answer = 2;\n");
  });

  it("edits text through FileSystemPort with a stale-write revision guard", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "alpha beta beta",
    });

    const output = await editHandler(
      {
        file_path: filePath,
        old_string: "beta",
        new_string: "gamma",
        replace_all: true,
      },
      contextWith(fs),
    );

    expect(output).toMatchObject({
      filePath,
      oldString: "beta",
      newString: "gamma",
      originalFile: "alpha beta beta",
      replaceAll: true,
      userModified: false,
    });
    expect(output.structuredPatch).toEqual([
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          "-alpha beta beta",
          "\\ No newline at end of file",
          "+alpha gamma gamma",
          "\\ No newline at end of file",
        ],
      },
    ]);
    expect(fs.lastWrite?.expectedRevision?.id).toBe(`rev:${filePath}:15`);
    expect(fs.files.get(filePath)).toBe("alpha gamma gamma");
  });

  it("edits CRLF files with LF strings from Read and preserves CRLF on disk", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "first\r\n\tsecond\r\nthird\r\n",
    });
    const context = contextWith(fs);

    const readOutput = await readHandler(
      {
        file_path: filePath,
      },
      context,
    );
    const modelContent = readToolEntry.formatModelContent?.(readOutput);
    expect(modelContent).toContain("2\t\tsecond");
    expect(modelContent).not.toContain("\r");

    const output = await editHandler(
      {
        file_path: filePath,
        old_string: "first\n\tsecond",
        new_string: "first\n\tchanged",
      },
      context,
    );

    expect(output).toMatchObject({
      oldString: "first\n\tsecond",
      newString: "first\n\tchanged",
      originalFile: "first\n\tsecond\nthird\n",
    });
    expect(fs.lastWrite?.lineEndings).toBe("CRLF");
    expect(fs.lastWrite?.content).toBe("first\n\tchanged\nthird\n");
    expect(fs.files.get(filePath)).toBe("first\r\n\tchanged\r\nthird\r\n");
  });

  it("edits LF files when old_string accidentally contains CRLF after Read", async () => {
    const jsxPath = join(projectRoot, "src", "Component.jsx");
    const fs = createMemoryFileSystem({
      [jsxPath]: "export function Component() {\n  return <div>old</div>;\n}\n",
    });
    const readFileState: ReadFileStateMap = new Map();
    const context = contextWith(fs, { readFileState });

    await readHandler({ file_path: jsxPath }, context);

    const output = await editHandler(
      {
        file_path: jsxPath,
        old_string: "export function Component() {\r\n  return <div>old</div>;\r\n}",
        new_string: "export function Component() {\n  return <div>new</div>;\n}",
      },
      context,
    );

    expect(output).toMatchObject({
      oldString: "export function Component() {\n  return <div>old</div>;\n}",
      newString: "export function Component() {\n  return <div>new</div>;\n}",
      originalFile: "export function Component() {\n  return <div>old</div>;\n}\n",
    });
    expect(fs.files.get(jsxPath)).toBe(
      "export function Component() {\n  return <div>new</div>;\n}\n",
    );
  });

  it("does not double carriage returns when new_string already contains CRLF", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "one\r\ntwo\r\nthree\r\n",
    });

    await editHandler(
      {
        file_path: filePath,
        old_string: "two",
        new_string: "two\r\ninserted",
      },
      contextWith(fs),
    );

    expect(fs.files.get(filePath)).toBe("one\r\ntwo\r\ninserted\r\nthree\r\n");
    expect(fs.files.get(filePath)).not.toContain("\r\r\n");
  });

  it("passes legacy text encoding metadata through Edit writes", async () => {
    const fs = createMemoryFileSystem(
      {
        [filePath]: "// 你好\nconst answer = 1;\n",
      },
      { encoding: "gb2312" },
    );

    await editHandler(
      {
        file_path: filePath,
        old_string: "const answer = 1;",
        new_string: "const answer = 2;",
      },
      contextWith(fs),
    );

    expect(fs.lastWrite?.encoding).toBe("gb2312");
    expect(fs.files.get(filePath)).toBe("// 你好\nconst answer = 2;\n");
  });

  it("preserves curly quote style when matching normalized quotes", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "const label = “Old value”;\n",
    });

    const output = await editHandler(
      {
        file_path: filePath,
        old_string: '"Old value"',
        new_string: '"New value"',
      },
      contextWith(fs),
    );

    expect(output.oldString).toBe("“Old value”");
    expect(output.newString).toBe("“New value”");
    expect(fs.files.get(filePath)).toBe("const label = “New value”;\n");
  });

  it("edits text when old_string accidentally includes Read line prefixes", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "\tfirst\n\tsecond\n",
    });

    const output = await editHandler(
      {
        file_path: filePath,
        old_string: "1: \tfirst\n2: \tsecond",
        new_string: "\tchanged\n\tsecond",
      },
      contextWith(fs),
    );

    expect(output).toMatchObject({
      oldString: "\tfirst\n\tsecond",
      matchStrategy: "line_number_prefix_stripped",
    });
    expect(fs.files.get(filePath)).toBe("\tchanged\n\tsecond\n");
  });

  it("edits text when indentation copied from Read has extra tabs", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "\tif (ready) {\n\t\tawait Load();\n\t}\n",
    });

    const output = await editHandler(
      {
        file_path: filePath,
        old_string: "\t\tif (ready) {\n\t\t\tawait Load();\n\t\t}",
        new_string: "\tif (ready) {\n\t\tawait Save();\n\t}",
      },
      contextWith(fs),
    );

    expect(output).toMatchObject({
      oldString: "\tif (ready) {\n\t\tawait Load();\n\t}",
      matchStrategy: "line_trimmed",
    });
    expect(fs.files.get(filePath)).toBe("\tif (ready) {\n\t\tawait Save();\n\t}\n");
  });

  it("rejects fuzzy edit matches when multiple candidates are possible", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "\tawait Load();\n  await Load();\n",
    });

    await expect(
      editHandler(
        {
          file_path: filePath,
          old_string: "\t\tawait Load();",
          new_string: "await Save();",
        },
        contextWith(fs),
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 9,
    });
    expect(fs.files.get(filePath)).toBe("\tawait Load();\n  await Load();\n");
  });

  it("applies structured patches after verifying all hunks", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "one\n  two\nthree\n",
    });

    const output = (await applyPatchHandler(
      {
        patch_text: [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          "-two",
          "+changed",
          "*** End Patch",
        ].join("\n"),
      },
      contextWith(fs),
    )) as ApplyPatchOutput;

    expect(output.summary).toContain(`M ${filePath}`);
    expect(output.files[0]).toMatchObject({
      filePath,
      type: "update",
      additions: 1,
      deletions: 1,
    });
    expect(fs.files.get(filePath)).toBe("one\nchanged\nthree\n");
  });

  it("passes legacy text encoding metadata through ApplyPatch updates", async () => {
    const fs = createMemoryFileSystem(
      {
        [filePath]: "// 你好\nconst answer = 1;\n",
      },
      { encoding: "gb2312" },
    );

    await applyPatchHandler(
      {
        patch_text: [
          "*** Begin Patch",
          `*** Update File: ${filePath}`,
          "@@",
          "-const answer = 1;",
          "+const answer = 2;",
          "*** End Patch",
        ].join("\n"),
      },
      contextWith(fs),
    );

    expect(fs.lastWrite?.encoding).toBe("gb2312");
    expect(fs.files.get(filePath)).toBe("// 你好\nconst answer = 2;\n");
  });

  it("does not write any patch files when verification fails", async () => {
    const createdPath = join(workspaceRoot, "created.txt");
    const fs = createMemoryFileSystem({
      [filePath]: "one\ntwo\n",
    });

    await expect(
      applyPatchHandler(
        {
          patch_text: [
            "*** Begin Patch",
            `*** Add File: ${createdPath}`,
            "+created",
            `*** Update File: ${filePath}`,
            "@@",
            "-missing",
            "+changed",
            "*** End Patch",
          ].join("\n"),
        },
        contextWith(fs),
      ),
    ).rejects.toMatchObject({
      type: "tool_execution_failed",
      context: {
        code: "apply_patch_hunk_not_found",
      },
    });

    expect(fs.files.has(createdPath)).toBe(false);
    expect(fs.files.get(filePath)).toBe("one\ntwo\n");
  });

  it("rejects ambiguous single replacements unless replace_all is explicit", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "alpha beta beta",
    });

    await expect(
      editHandler(
        {
          file_path: filePath,
          old_string: "beta",
          new_string: "gamma",
        },
        contextWith(fs),
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 9,
    });
    expect(fs.files.get(filePath)).toBe("alpha beta beta");
  });

  it("rejects empty old_string instead of inserting text implicitly", async () => {
    const fs = createMemoryFileSystem({
      [filePath]: "alpha",
    });

    await expect(
      editHandler(
        {
          file_path: filePath,
          old_string: "",
          new_string: "prefix ",
        },
        contextWith(fs),
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 3,
    });
    expect(fs.files.get(filePath)).toBe("alpha");
  });
});

interface MemoryFileSystem extends FileSystemPort {
  files: Map<string, string>;
  readPaths: string[];
  lastWrite?: FileSystemWriteTextRequest;
  lastSearchFiles?: { path: string; pattern: string };
  lastSearchText?: { path: string; pattern: string; glob?: string };
}

function createMemoryFileSystem(
  initial: Record<string, string>,
  options: { encoding?: FileSystemTextEncoding } = {},
): MemoryFileSystem {
  const files = new Map(Object.entries(initial));
  const fs: MemoryFileSystem = {
    files,
    readPaths: [],
    async stat(request): Promise<FileSystemStatResult> {
      const content = files.get(request.path);
      if (content === undefined) {
        throw createFileSystemError({
          code: "not_found",
          path: request.path,
          message: `missing: ${request.path}`,
        });
      }
      return {
        path: request.path,
        kind: "file",
        sizeBytes: Buffer.byteLength(content, "utf8"),
        revision: revisionFor(request.path, content),
      };
    },
    async readBinaryFile(request) {
      fs.readPaths.push(request.path);
      const content = files.get(request.path);
      if (content === undefined) {
        throw createFileSystemError({
          code: "not_found",
          path: request.path,
          message: `missing: ${request.path}`,
        });
      }
      const buffer = Buffer.from(content, "utf8");
      if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
        throw createFileSystemError({
          code: "too_large",
          path: request.path,
          message: `File content (${formatTestFileSize(buffer.byteLength)}) exceeds maximum allowed size (${formatTestFileSize(request.maxBytes)}).`,
        });
      }
      return {
        path: request.path,
        content: buffer,
        bytesRead: buffer.byteLength,
        sizeBytes: buffer.byteLength,
        revision: revisionFor(request.path, content),
      };
    },
    async readTextFile(request): Promise<FileSystemReadTextResult> {
      fs.readPaths.push(request.path);
      const content = files.get(request.path);
      if (content === undefined) {
        throw createFileSystemError({
          code: "not_found",
          path: request.path,
          message: `missing: ${request.path}`,
        });
      }
      const lineEndings = detectTestLineEndings(content);
      const normalizedContent = normalizeTestLineEndings(content);
      return {
        path: request.path,
        content: normalizedContent,
        encoding: request.encoding ?? options.encoding ?? "utf8",
        lineEndings,
        bytesRead: content.length,
        sizeBytes: content.length,
        truncated: false,
        revision: revisionFor(request.path, content),
      };
    },
    async readTextFileRange(request): Promise<FileSystemReadTextRangeResult> {
      fs.readPaths.push(request.path);
      const content = files.get(request.path);
      if (content === undefined) {
        throw createFileSystemError({
          code: "not_found",
          path: request.path,
          message: `missing: ${request.path}`,
        });
      }
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (request.maxBytes !== undefined && sizeBytes > request.maxBytes) {
        throw createFileSystemError({
          code: "too_large",
          path: request.path,
          message: `File content (${formatTestFileSize(sizeBytes)}) exceeds maximum allowed size (${formatTestFileSize(request.maxBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
        });
      }
      const lineEndings = detectTestLineEndings(content);
      const normalizedContent = normalizeTestLineEndings(content);
      const lines = normalizedContent.length === 0 ? [] : normalizedContent.split("\n");
      const offsetLine = Math.max(0, Math.trunc(request.offsetLine ?? 0));
      const limitLines =
        request.limitLines === undefined ? undefined : Math.max(0, Math.trunc(request.limitLines));
      const selected =
        limitLines === undefined
          ? lines.slice(offsetLine)
          : lines.slice(offsetLine, offsetLine + limitLines);
      return {
        path: request.path,
        content: selected.join("\n"),
        encoding: request.encoding ?? options.encoding ?? "utf8",
        lineEndings,
        bytesRead: sizeBytes,
        sizeBytes,
        truncated: false,
        startLine: offsetLine + 1,
        lineCount: selected.length,
        totalLines: lines.length,
        revision: revisionFor(request.path, content),
      };
    },
    async writeTextFile(request) {
      if (request.expectedRevision) {
        const current = files.get(request.path);
        if (!current || revisionFor(request.path, current).id !== request.expectedRevision.id) {
          throw createFileSystemError({
            code: "stale_write",
            path: request.path,
            message: `stale: ${request.path}`,
          });
        }
      }
      fs.lastWrite = request;
      const content = applyTestLineEndings(request.content, request.lineEndings);
      files.set(request.path, content);
      return {
        path: request.path,
        bytesWritten: content.length,
        revision: revisionFor(request.path, content),
      };
    },
    async removeFile(request) {
      const existed = files.delete(request.path);
      if (!existed && request.missingOk !== true) {
        throw createFileSystemError({
          code: "not_found",
          path: request.path,
          message: `missing: ${request.path}`,
        });
      }
      return {
        path: request.path,
        removed: existed,
      };
    },
    async listDirectory(request) {
      const prefix = `${request.path.replace(/\/+$/, "")}/`;
      const seen = new Set<string>();
      const entries = Array.from(files.keys())
        .filter((path) => path.startsWith(prefix))
        .flatMap((path) => {
          const rest = path.slice(prefix.length);
          const [name] = rest.split("/");
          if (!name || seen.has(name)) return [];
          seen.add(name);
          return [
            {
              kind: rest.includes("/") ? ("directory" as const) : ("file" as const),
              name,
              path: `${prefix}${name}`,
            },
          ];
        });
      return {
        path: request.path,
        durationMs: 0,
        entries,
        numEntries: entries.length,
      };
    },
    async searchFiles(request): Promise<FileSystemSearchFilesResult> {
      fs.lastSearchFiles = { path: request.path, pattern: request.pattern };
      const matcher = createTestGlobMatcher(request.pattern);
      const filesMatched = Array.from(files.keys())
        .filter((path) => path.startsWith(request.path))
        .filter((path) => matcher(toRelativeTestPath(request.path, path)))
        .sort();
      const offset = request.offset ?? 0;
      const limit = request.maxResults ?? 100;
      const selected = filesMatched.slice(offset, offset + limit);
      return {
        path: request.path,
        pattern: request.pattern,
        durationMs: 0,
        files: selected,
        numFiles: selected.length,
        truncated: filesMatched.length > offset + limit,
      };
    },
    async searchText(request, options): Promise<FileSystemSearchTextResult> {
      fs.lastSearchText = { path: request.path, pattern: request.pattern, glob: request.glob };
      if (options?.signal?.aborted) {
        throw createFileSystemError({
          code: "cancelled",
          path: request.path,
          message: `cancelled: ${request.path}`,
        });
      }
      const regex = new RegExp(request.pattern, request.ignoreCase ? "i" : "");
      const globMatcher = request.glob ? createTestGlobMatcher(request.glob) : undefined;
      const entries = [];
      const countEntries = [];
      const matchedFiles: string[] = [];
      let numMatches = 0;

      for (const [path, content] of Array.from(files.entries()).sort()) {
        if (!path.startsWith(request.path)) continue;
        const relativePath = toRelativeTestPath(request.path, path);
        if (globMatcher && !globMatcher(relativePath)) continue;
        const lines = content.split("\n");
        let fileMatches = 0;
        for (let index = 0; index < lines.length; index += 1) {
          if (regex.test(lines[index] ?? "")) {
            fileMatches += 1;
            entries.push({
              path,
              lineNumber: index + 1,
              text: lines[index] ?? "",
              matched: true,
            });
          }
        }
        if (fileMatches > 0) {
          matchedFiles.push(path);
          countEntries.push({ path, count: fileMatches });
          numMatches += fileMatches;
        }
      }

      const mode = request.outputMode ?? "files_with_matches";
      return {
        path: request.path,
        pattern: request.pattern,
        mode,
        durationMs: 0,
        files: matchedFiles,
        entries: mode === "count" ? countEntries : mode === "content" ? entries : [],
        numMatches,
        truncated: false,
      };
    },
  };
  return fs;
}

function detectTestLineEndings(content: string): FileSystemLineEndings {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    if (index > 0 && content[index - 1] === "\r") {
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}

function normalizeTestLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

function applyTestLineEndings(
  content: string,
  lineEndings: FileSystemLineEndings | undefined,
): string {
  if (lineEndings === undefined) {
    return content;
  }
  const normalized = normalizeTestLineEndings(content);
  return lineEndings === "CRLF" ? normalized.split("\n").join("\r\n") : normalized;
}

function revisionFor(path: string, content: string): FileSystemRevision {
  return {
    id: `rev:${path}:${content.length}`,
    sizeBytes: content.length,
  };
}

function createReadFileState(filePath: string, content: string): ReadFileStateMap {
  const revision = revisionFor(filePath, content);
  return new Map([
    [
      createReadFileStateKey(filePath, 1, undefined),
      {
        path: filePath,
        content: normalizeTestLineEndings(content),
        offset: 1,
        limit: undefined,
        isPartialView: false,
        readAt: new Date(),
        revisionId: revision.id,
        sizeBytes: revision.sizeBytes,
      },
    ],
  ]);
}

function formatTestFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)}KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

function createTestGlobMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/");
  let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        regex += "(?:.*/)?";
        index += 2;
      } else {
        regex += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    regex += char?.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") ?? "";
  }
  return (path: string) => new RegExp(`${regex}$`).test(path.replaceAll("\\", "/"));
}

function toRelativeTestPath(root: string, path: string): string {
  return path
    .slice(root.length)
    .replace(/^[/\\]/, "")
    .replaceAll("\\", "/");
}

function contextWith(
  fileSystemPort: FileSystemPort,
  options: {
    imageProcessorPort?: ImageProcessorPort;
    readFileState?: ReadFileStateMap;
    workingDirectory?: string;
    workspaceRoot?: string;
  } = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    spanId: "span_test",
    abortSignal: new AbortController().signal,
    fileSystemPort,
    imageProcessorPort: options.imageProcessorPort,
    readFileState: options.readFileState,
    workingDirectory: options.workingDirectory ?? workspaceRoot,
    workspaceRoot: options.workspaceRoot ?? workspaceRoot,
    sessionId: "sess_test",
    turnId: "turn_test",
  };
}
