import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CodeCommandCall {
  argumentCount: number;
  argumentHashes: string[];
}

/** 只保存参数摘要，避免将错误 URI 中意外夹带的 authority/凭据写入证据。 */
export async function readCodeCommandCalls(logPath: string): Promise<CodeCommandCall[]> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const call = JSON.parse(line) as CodeCommandCall;
      if (
        !Number.isInteger(call.argumentCount) ||
        !Array.isArray(call.argumentHashes) ||
        call.argumentHashes.length !== call.argumentCount ||
        !call.argumentHashes.every(
          (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash),
        )
      ) {
        throw new Error("code CLI 录制结果格式错误");
      }
      return call;
    });
}

/** macOS/Linux 的真实可执行夹具；只替代外部编辑器进程，不替代 Main 的 URI 构造。 */
export async function createCodeCommandRecorder(artifactDir: string) {
  if (process.platform === "win32") throw new Error("Windows 需提供可执行 code.exe 录制夹具");
  await mkdir(artifactDir, { recursive: true });
  const binDir = await mkdtemp(join(artifactDir, "editor-cli-"));
  const commandPath = join(binDir, "code");
  const scriptPath = join(binDir, "record.cjs");
  const logPath = join(binDir, "code-calls.jsonl");
  await writeFile(
    scriptPath,
    [
      'const { appendFile } = require("node:fs/promises");',
      'const { createHash } = require("node:crypto");',
      "const args = process.argv.slice(2);",
      'const call = { argumentCount: args.length, argumentHashes: args.map(value => createHash("sha256").update(value).digest("hex")) };',
      `appendFile(${JSON.stringify(logPath)}, JSON.stringify(call) + "\\n", { mode: 0o600 }).catch(error => { console.error(error.message); process.exitCode = 1; });`,
    ].join("\n"),
    { mode: 0o600 },
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    commandPath,
    `#!/bin/sh\nunset NODE_OPTIONS\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`,
    { mode: 0o755 },
  );
  return { binDir, commandPath, logPath, readCalls: () => readCodeCommandCalls(logPath) };
}
