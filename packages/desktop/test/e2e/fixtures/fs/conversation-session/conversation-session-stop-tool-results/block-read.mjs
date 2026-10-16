import { appendFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const filename = basename(input.tool_input?.file_path ?? "");
if (
  basename(dirname(input.tool_input?.file_path ?? "")) ===
    "conversation-session-stop-tool-results" &&
  ["blocked-2.txt", "blocked-3.txt"].includes(filename)
) {
  await appendFile(
    process.argv[2],
    JSON.stringify({
      phase: "blocked",
      at: new Date().toISOString(),
      hook_event_name: input.hook_event_name,
      session_id: input.session_id,
      tool_use_id: input.tool_use_id,
    }) + "\n",
  );
  // 不依赖固定延时放行：由真实 Stop 取消 Hook 子进程；超时只作失控保护。
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  process.stdout.write("{}");
}
