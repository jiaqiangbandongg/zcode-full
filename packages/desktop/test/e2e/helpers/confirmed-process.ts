import { spawn } from "node:child_process";

/** 按真实提示逐次确认；固定 sleep 会拖慢卸载，也可能把两个回答送进同一个 stdin.once。 */
export function runConfirmedProcess(
  command: string,
  args: string[],
  options: { prompts: readonly string[]; answer: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let confirmed = 0;
    let cursor = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`确认进程超时：确认 ${confirmed}/${options.prompts.length}`));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const prompt = options.prompts[confirmed];
      if (prompt === undefined) return;
      const index = stdout.indexOf(prompt, cursor);
      if (index < 0) return;
      cursor = index + prompt.length;
      confirmed++;
      // 最后一次回答后关闭输入，CLI 的 stdin 数据监听器才能自然结束。
      if (confirmed === options.prompts.length) child.stdin.end(`${options.answer}\n`);
      else child.stdin.write(`${options.answer}\n`);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", reject);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || confirmed !== options.prompts.length) {
        reject(
          new Error(`确认进程退出 ${code}：确认 ${confirmed}/${options.prompts.length}；${stderr}`),
        );
      } else resolve({ stdout, stderr });
    });
  });
}
