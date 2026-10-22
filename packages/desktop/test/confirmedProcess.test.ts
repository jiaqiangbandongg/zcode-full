import { expect, it } from "vitest";
import { runConfirmedProcess } from "#e2e/helpers/confirmed-process";

it("读取两个真实提示后分别确认；提示可跨 stdout chunk，不使用固定等待", async () => {
  const code = `
    process.stdout.write("First confirmation: ");
    process.stdin.once("data", (first) => {
      if (String(first) !== "DELETE\\n") process.exit(11);
      process.stdout.write("Second ");
      setImmediate(() => process.stdout.write("confirmation: "));
      process.stdin.once("data", (second) => {
        if (String(second) !== "DELETE\\n") process.exit(12);
        process.stdout.write('{"uninstalled":true}');
        process.stdin.pause();
      });
    });
  `;
  const result = await runConfirmedProcess(process.execPath, ["-e", code], {
    prompts: ["First confirmation: ", "Second confirmation: "],
    answer: "DELETE",
    timeoutMs: 5000,
  });
  expect(result.stdout).toContain('"uninstalled":true');
});

it("进程未完成所有确认即退出不能报告卸载成功", async () => {
  await expect(
    runConfirmedProcess(process.execPath, ["-e", 'process.stdout.write("early exit")'], {
      prompts: ["Confirm"],
      answer: "DELETE",
      timeoutMs: 5000,
    }),
  ).rejects.toThrow("确认 0/1");
});
