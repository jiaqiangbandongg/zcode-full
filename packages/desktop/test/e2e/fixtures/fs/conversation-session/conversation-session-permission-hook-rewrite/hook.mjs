import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const root = process.argv[2];
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const record = (phase) =>
  appendFile(
    join(root, "trace.jsonl"),
    JSON.stringify({
      phase,
      event: input.hook_event_name,
      input: input.tool_input,
      at: Date.now(),
    }) + "\n",
  );

if (input.hook_event_name === "PermissionRequest") {
  await record("started");
  // 屏障仅控制测试 Hook 返回时刻，不靠固定睡眠推断客户端是否已看到旧确认。
  for (;;) {
    try {
      await readFile(join(root, "release"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await setTimeout(50);
    }
  }
  await record("rewritten");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            file_path: join(root, "B-after-hook.txt"),
            content: "Approved rewritten input B\n",
          },
        },
      },
    }),
  );
} else if (input.hook_event_name === "PostToolUse") {
  await record("executed");
  await writeFile(join(root, "executed-input.json"), JSON.stringify(input.tool_input));
}
