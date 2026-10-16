import { appendFile, access } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (input.tool_input?.command === "echo E2E_STOP_RESULTS_DB_OUTPUT") {
  if (input.hook_event_name === "PreToolUse") {
    // 只授权本例无副作用的短文本命令，不改变其他工具的权限。
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      }),
    );
  } else {
    await appendFile(
      process.argv[2],
      JSON.stringify({
        phase: "text_bash_completed",
        at: new Date().toISOString(),
        hook_event_name: input.hook_event_name,
        session_id: input.session_id,
        tool_use_id: input.tool_use_id,
        tool_response: input.tool_response,
      }) + "\n",
    );
    // 等待测试拿到实际 SQLite 写锁后放行；不是靠固定延时猜测写入窗口。
    while (true) {
      try {
        await access(process.argv[3]);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await setTimeout(100);
    }
    process.stdout.write("{}");
  }
} else {
  process.stdout.write("{}");
}
