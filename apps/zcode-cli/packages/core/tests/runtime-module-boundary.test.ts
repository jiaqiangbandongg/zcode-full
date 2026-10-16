import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const maxRuntimeSourceLines = 400;
const lineCountExemptFiles = new Set([
  // 现存大文件是显式重构债务；边界测试继续阻止新增未登记的大文件。
  ...[
    "agent-runtime.ts",
    "internal-turn-methods.ts",
    "types.ts",
    "methods/background.ts",
    "methods/compact-active.ts",
    "methods/compact-persistence.ts",
    "methods/compact-summary-model-request.ts",
    "methods/compact.ts",
    "methods/context-usage.ts",
    "methods/events.ts",
    "methods/file-rewind.ts",
    "methods/message-persistence.ts",
    "methods/model.ts",
    "methods/resume.ts",
    "methods/rewind-message.ts",
    "methods/runtime-command-queue.ts",
    "methods/session-fork.ts",
    "methods/session-title.ts",
    "methods/steering.ts",
    "methods/subagent.ts",
    "methods/target-completion-verification.ts",
    "methods/target.ts",
    "methods/turn-model-step.ts",
    "methods/turn-tools.ts",
    "methods/turn.ts",
    "methods/usage-observability.ts",
    "helpers/attachment-media-resolver.ts",
    "helpers/compact-selection.ts",
    "helpers/provider-request-messages.ts",
  ].map((file) => join(repoRoot, "packages/core/src/runtime", file)),
]);

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(path)));
      continue;
    }
    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

describe("runtime module boundary", () => {
  it("keeps runtime source modules below the file-size ceiling", async () => {
    const files = [
      join(repoRoot, "packages/core/src/runtime.ts"),
      ...(await collectTypeScriptFiles(join(repoRoot, "packages/core/src/runtime"))),
    ];

    for (const file of files) {
      if (lineCountExemptFiles.has(file)) continue;
      const content = await readFile(file, "utf8");
      expect(countLines(content), relative(repoRoot, file)).toBeLessThanOrEqual(
        maxRuntimeSourceLines,
      );
    }
  });
});
