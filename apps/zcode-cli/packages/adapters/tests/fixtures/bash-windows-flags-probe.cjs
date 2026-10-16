// Windows 负对照：node bash-windows-flags-probe.cjs；不依赖 adapter，保留旧 append 故障证据。
const assert = require("node:assert/strict");
const { constants } = require("node:fs");
const { mkdtemp, open, readFile, rm } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

async function main() {
  assert.equal(process.platform, "win32", "Run this negative control on Windows");
  const root = await mkdtemp(join(tmpdir(), "zcode-flags-probe-"));
  const cases = [];
  const shells = [
    [
      "bash-builtin",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      ["--noprofile", "--norc", "-c", "printf out; printf err >&2"],
    ],
    [
      "bash-external",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      ["--noprofile", "--norc", "-c", "/usr/bin/printf out; /usr/bin/printf err >&2"],
    ],
    ["cmd", process.env.ComSpec, ["/d", "/s", "/c", "echo out&1>&2 echo err"]],
  ];
  try {
    for (const [name, shell, args] of shells) {
      for (const [mode, flags] of [
        [
          "old-append",
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_APPEND |
            constants.O_TRUNC |
            (constants.O_NOFOLLOW ?? 0),
        ],
        ["w", "w"],
      ]) {
        const path = join(root, `${name}-${mode}.log`);
        const handle = await open(path, flags, 0o600);
        let completion;
        try {
          const child = spawn(shell, args, {
            stdio: ["ignore", handle.fd, handle.fd],
            windowsHide: true,
          });
          completion = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => resolve(code));
          });
        } finally {
          await handle.close();
        }
        const exitCode = await completion;
        const output = await readFile(path, "utf8");
        if (mode === "w" || name === "cmd") {
          assert.equal(exitCode, 0);
          assert.equal(output.replace(/\r?\n/g, ""), "outerr");
        }
        // 不把 MSYS 的旧 bug 固化为永远必须失败：若新版修好，报告仍如实保留旧模式结果。
        cases.push({
          name,
          mode,
          exitCode,
          output,
          completeOutput: output.replace(/\r?\n/g, "") === "outerr",
        });
      }
    }
    console.log(
      JSON.stringify({ node: process.version, platform: process.platform, cases }, null, 2),
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
