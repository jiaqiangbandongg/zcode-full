import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OfficeError } from "#office/contract.ts";
import { createDocumentOwner } from "#office/app/documents.ts";
import { createWorkspaceFiles, createDocumentImporter } from "#office/adapters/files.ts";
import { createOfficeServer } from "#office/adapters/server.ts";
import { PARSERS } from "#office/adapters/parsers.ts";

// 官方插件宿主通过导出的 main 启动；导入时直接连接会被宿主判定为无效入口。
export async function main(): Promise<void> {
  const dist = dirname(fileURLToPath(import.meta.url));
  const assetRoot = join(dist, "ui");
  const pdfAssets = {
    cMapUrl: `${join(assetRoot, "pdfjs/cmaps")}/`,
    standardFontDataUrl: `${join(assetRoot, "pdfjs/standard_fonts")}/`,
  };
  const workspace = process.env.ZCODE_WORKSPACE_ROOT || process.cwd();

  const owner = createDocumentOwner({
    files: createWorkspaceFiles(workspace),
    async parse(file) {
      const parse = PARSERS[file.kind];
      if (!parse) throw new OfficeError("unsupported_type", `Unsupported file: ${file.path}`);
      return parse(file.bytes, file.path, pdfAssets);
    },
  });

  const reportCleanupError = (error: unknown) =>
    process.stderr.write(`Document import cleanup: ${String(error)}\n`);
  const importer = createDocumentImporter(workspace, { onCleanupError: reportCleanupError });
  await importer.initialize();
  const server = createOfficeServer({ owner, assetRoot, importer });
  let stopping = false;
  async function close() {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } finally {
      await importer.close();
    }
  }
  process.once("SIGTERM", () => void close().catch(reportCleanupError));
  process.once("SIGINT", () => void close().catch(reportCleanupError));
  process.stdin.once("end", () => void close().catch(reportCleanupError));
  await server.connect(new StdioServerTransport());
}

// 保留独立 Node 进程直接启动的用法。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
