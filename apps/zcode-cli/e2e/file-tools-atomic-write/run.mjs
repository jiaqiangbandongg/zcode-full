#!/usr/bin/env node

import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../..");

async function main() {
  if (process.platform === "win32") {
    console.log(JSON.stringify({ reason: "POSIX mode semantics are not available on win32", status: "skipped" }));
    return;
  }

  const [{ writeToolEntry }, { editToolEntry }, { createNodeFileSystemAdapter }] = await Promise.all([
    import(pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/core/dist/tool/handlers/write.js")).href),
    import(pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/core/dist/tool/handlers/edit.js")).href),
    import(pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/adapters/dist/fs/index.js")).href),
  ]);

  const writeTool = requireTool(writeToolEntry, "Write");
  const editTool = requireTool(editToolEntry, "Edit");
  const runRoot = await mkdtemp(join(tmpdir(), "zcode-file-tools-atomic-e2e-"));
  const fsPort = createNodeFileSystemAdapter();
  const results = [];

  try {
    const writePath = join(runRoot, "write.sh");
    await writeFile(writePath, "#!/usr/bin/env bash\necho old-write\n", "utf8");
    await chmod(writePath, 0o755);
    await writeTool.handler(
      {
        file_path: writePath,
        content: "#!/usr/bin/env bash\necho new-write\n",
      },
      createToolContext({
        fsPort,
        readFileState: await readStateFor(fsPort, writePath),
        workspaceRoot: runRoot,
      }),
    );
    await assertFile(writePath, "#!/usr/bin/env bash\necho new-write\n", 0o755);
    results.push({ case: "write-preserves-executable-mode", status: "passed" });

    const editPath = join(runRoot, "edit.sh");
    await writeFile(editPath, "#!/usr/bin/env bash\necho old-edit\n", "utf8");
    await chmod(editPath, 0o755);
    await editTool.handler(
      {
        file_path: editPath,
        old_string: "old-edit",
        new_string: "new-edit",
      },
      createToolContext({
        fsPort,
        workspaceRoot: runRoot,
      }),
    );
    await assertFile(editPath, "#!/usr/bin/env bash\necho new-edit\n", 0o755);
    results.push({ case: "edit-preserves-executable-mode", status: "passed" });

    const targetPath = join(runRoot, "target.sh");
    const linkPath = join(runRoot, "link.sh");
    await writeFile(targetPath, "#!/usr/bin/env bash\necho target\n", "utf8");
    await chmod(targetPath, 0o755);
    await symlink(targetPath, linkPath);
    await assertRejectsSymlinkWrite(writeTool, fsPort, linkPath, runRoot);
    expectEqual(await readFile(targetPath, "utf8"), "#!/usr/bin/env bash\necho target\n", "symlink target content");
    results.push({ case: "write-rejects-symlink-target", status: "passed" });

    console.log(JSON.stringify({ cases: results, status: "passed" }, null, 2));
  } finally {
    await rm(runRoot, { force: true, recursive: true });
  }
}

function requireTool(toolEntry, name) {
  if (toolEntry.metadata?.name !== name) {
    throw new Error(`Missing built-in tool: ${name}`);
  }
  return toolEntry;
}

function createToolContext({ fsPort, readFileState, workspaceRoot }) {
  return {
    abortSignal: new AbortController().signal,
    fileSystemPort: fsPort,
    readFileState,
    sessionId: "file_tools_atomic_write_e2e_session",
    spanId: "file_tools_atomic_write_e2e_span",
    toolCallId: "file_tools_atomic_write_e2e_tool",
    traceId: "file_tools_atomic_write_e2e_trace",
    turnId: "file_tools_atomic_write_e2e_turn",
    workingDirectory: workspaceRoot,
    workspaceRoot,
  };
}

async function readStateFor(fsPort, filePath) {
  const read = await fsPort.readTextFile({ path: filePath });
  return new Map([
    [
      filePath,
      {
        content: read.content,
        isPartialView: false,
        limit: undefined,
        mtimeMs: read.revision?.mtimeMs === undefined ? undefined : Math.floor(read.revision.mtimeMs),
        offset: undefined,
        path: filePath,
        readAt: new Date(),
        revisionId: read.revision?.id,
        sizeBytes: read.revision?.sizeBytes ?? Buffer.byteLength(read.content, "utf8"),
        sourceTool: "Read",
      },
    ],
  ]);
}

async function assertFile(filePath, expectedContent, expectedMode) {
  expectEqual(await readFile(filePath, "utf8"), expectedContent, `${filePath} content`);
  const actualMode = (await stat(filePath)).mode & 0o777;
  expectEqual(actualMode, expectedMode, `${filePath} mode`);
}

async function assertRejectsSymlinkWrite(writeTool, fsPort, linkPath, workspaceRoot) {
  try {
    await writeTool.handler(
      {
        file_path: linkPath,
        content: "#!/usr/bin/env bash\necho overwritten\n",
      },
      createToolContext({
        fsPort,
        readFileState: await readStateFor(fsPort, linkPath),
        workspaceRoot,
      }),
    );
  } catch (error) {
    const expectedMessage = `Refusing to write through symlink: ${linkPath}. Resolve the symlink and pass the real target path explicitly.`;
    if (error?.message !== expectedMessage) {
      throw new Error(`Unexpected symlink error message: ${error?.message}`, { cause: error });
    }
    return;
  }
  throw new Error("Expected Write through symlink to be rejected");
}

function expectEqual(actual, expected, label) {
  if (actual === expected) return;
  throw new Error(`${label}: expected ${formatValue(expected)}, got ${formatValue(actual)}`);
}

function formatValue(value) {
  return typeof value === "number" ? `0o${value.toString(8)}` : JSON.stringify(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
