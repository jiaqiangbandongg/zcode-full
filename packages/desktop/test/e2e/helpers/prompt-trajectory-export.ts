import { execFile } from "node:child_process";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getE2EAppDataPaths } from "./desktop-app.js";

interface TrajectoryManifest {
  trajectories: Array<{ id: string; reason: string; requestCount: number }>;
}
const execute = promisify(execFile);
const cliPath = fileURLToPath(
  new URL("../../../../../apps/zcode-cli/tools/prompt-trajectory/src/cli.ts", import.meta.url),
);
const tsxCli = createRequire(cliPath).resolve("tsx/cli");

/** 清理隔离 HOME 前保留原始 model-io，并调用仓库工具的公开 CLI 导出，不能伪造输入日志。 */
export async function exportPromptTrajectory(
  sessionId: string,
  label: string,
  querySource = "main_turn",
): Promise<TrajectoryManifest> {
  const artifactRoot = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactRoot) throw new Error("Missing ZCODE_E2E_ARTIFACT_DIR");
  const out = join(artifactRoot, "prompt-trajectory", label);
  await mkdir(out, { recursive: true });
  const capture = process.env.E2E_PROVIDER_CAPTURE_PATH;
  if (capture) await copyFile(capture, join(out, "provider-capture.json"));
  const source = join(
    getE2EAppDataPaths().storageRoot,
    "cli",
    "debug",
    `model-io-${sessionId}.jsonl`,
  );
  const input = join(out, `model-io-${sessionId}.jsonl`);
  await browser.waitUntil(
    async () => {
      const text = await readFile(source, "utf8").catch(() => "");
      return text.includes(JSON.stringify(querySource)) && text.endsWith("\n");
    },
    { timeout: 15000, timeoutMsg: `原始 model-io 不存在: ${sessionId}` },
  );
  await copyFile(source, input);
  await execute(
    process.execPath,
    [tsxCli, cliPath, "model-io", "--input", input, "--out", out, "--query-source", querySource],
    {
      timeout: 30000,
    },
  );
  return JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as TrajectoryManifest;
}
