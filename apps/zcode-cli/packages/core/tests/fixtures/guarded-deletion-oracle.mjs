import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// 只执行固定命令，cwd/目标全部属于本次临时目录；不接收用户提供的删除目标。
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "zcode-deletion-oracle-"));
const results = [];
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function seed(directory) {
  await mkdir(directory, { recursive: true });
  for (const name of ["one.txt", "two.txt"]) await writeFile(join(directory, name), name);
}
async function run(label, shell, command, setup, verify) {
  const cwd = join(root, String(results.length));
  await mkdir(cwd);
  await setup(cwd);
  if (typeof command === "function") command = command(cwd);
  const args = shell.endsWith("cmd.exe") ? ["/d", "/s", "/c", command] : ["-c", command];
  try {
    await exec(shell, args, {
      cwd,
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
  } catch (error) {
    // Robocopy 0..7 是成功/差异位图，非一般 Unix exit code。
    if (!(/(?:^| )robocopy /.test(command) && Number(error.code) >= 0 && Number(error.code) < 8))
      throw error;
  }
  await verify(cwd);
  results.push({ label, command });
}
try {
  if (process.platform === "win32") {
    const cmd = process.env.ComSpec;
    assert.ok(cmd?.toLowerCase().endsWith("cmd.exe"));
    await run(
      "CMD rd /s /q",
      cmd,
      "rd /s /q target",
      (p) => seed(join(p, "target")),
      async (p) => assert.equal(await exists(join(p, "target")), false),
    );
    await run(
      "CMD rd combined /s/q",
      cmd,
      "rd /s/q target",
      (p) => seed(join(p, "target")),
      async (p) => assert.equal(await exists(join(p, "target")), false),
    );
    for (const command of ["rd target/s/q", "rd/s/q target", "rd target^/s/q"]) {
      await run(
        "CMD attached delete switches",
        cmd,
        command,
        (p) => seed(join(p, "target")),
        async (p) => assert.equal(await exists(join(p, "target")), false),
      );
    }
    await run(
      "CMD del attached switch",
      cmd,
      "del/q target\\one.txt",
      (p) => seed(join(p, "target")),
      async (p) => {
        assert.equal(await exists(join(p, "target", "one.txt")), false);
        assert.equal(await exists(join(p, "target", "two.txt")), true);
      },
    );
    await run(
      "CMD del single file",
      cmd,
      "del target\\one.txt",
      (p) => seed(join(p, "target")),
      async (p) => {
        assert.equal(await exists(join(p, "target", "one.txt")), false);
        assert.equal(await exists(join(p, "target", "two.txt")), true);
      },
    );
    await run(
      "CMD erase directory target",
      cmd,
      "erase /q target",
      (p) => seed(join(p, "target")),
      async (p) => {
        assert.equal(await exists(join(p, "target")), true);
        assert.equal(await exists(join(p, "target", "two.txt")), false);
      },
    );
    for (const flags of ["/MIR", "/PURGE", "/MIR /L", "/MIR /XF /L", "/XF /MIR"]) {
      await run(
        `CMD robocopy ${flags}`,
        cmd,
        `robocopy src dst ${flags} /R:0 /W:0`,
        async (p) => {
          await mkdir(join(p, "src"));
          await seed(join(p, "dst"));
        },
        async (p) => {
          const preserved = await exists(join(p, "dst", "one.txt"));
          assert.equal(preserved, flags.includes("/L"));
        },
      );
    }
    await run(
      "CMD Robocopy leading switch",
      cmd,
      "robocopy /MIR src dst /R:0 /W:0",
      async (p) => {
        await mkdir(join(p, "src"));
        await seed(join(p, "dst"));
      },
      async (p) => assert.equal(await exists(join(p, "dst", "one.txt")), false),
    );
  }
  const shell =
    process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
  assert.equal(await exists(shell), true, `Required shell unavailable: ${shell}`);
  if (process.platform === "darwin") {
    for (const flags of ["-d", "-x", "-d -x"]) {
      await run(
        "BSD find leading flags",
        shell,
        `find ${flags} target -type f -delete`,
        (p) => seed(join(p, "target")),
        async (p) => {
          assert.equal(await exists(join(p, "target", "one.txt")), false);
          assert.equal(await exists(join(p, "target", "two.txt")), false);
        },
      );
    }
    for (const filename of ["--help", "--version", "-f", "--"]) {
      await run(
        "BSD rm trailing option-shaped target",
        shell,
        `rm first ${filename}`,
        async (p) => {
          await writeFile(join(p, "first"), "fixture");
          await writeFile(join(p, filename), "fixture");
        },
        async (p) => {
          assert.equal(await exists(join(p, "first")), false);
          assert.equal(await exists(join(p, filename)), false);
        },
      );
    }
  }
  await run(
    "Bash recursive rm without force",
    shell,
    "rm -r target",
    (p) => seed(join(p, "target")),
    async (p) => assert.equal(await exists(join(p, "target")), false),
  );
  await run(
    "Bash batch rm",
    shell,
    "rm target/one.txt target/two.txt",
    (p) => seed(join(p, "target")),
    async (p) => assert.equal(await exists(join(p, "target", "two.txt")), false),
  );
  await run(
    "Bash glob rm",
    shell,
    "rm target/*.txt",
    (p) => seed(join(p, "target")),
    async (p) => assert.equal(await exists(join(p, "target", "one.txt")), false),
  );
  if (process.platform !== "win32")
    await run(
      "Bash quoted glob literal",
      shell,
      "rm 'target/*.txt'",
      async (p) => {
        await seed(join(p, "target"));
        // Windows 不支持文件名中的 *；这里的字面 glob oracle 只在 POSIX 执行。
        await writeFile(join(p, "target", "*.txt"), "literal");
      },
      async (p) => assert.equal(await readFile(join(p, "target", "one.txt"), "utf8"), "one.txt"),
    );
  await run(
    "Bash find -delete",
    shell,
    "find target -type f -delete",
    (p) => seed(join(p, "target")),
    async (p) => assert.equal(await exists(join(p, "target", "one.txt")), false),
  );
  await run(
    "Bash find predicate value",
    shell,
    "find target -name '-delete' -print",
    (p) => seed(join(p, "target")),
    async (p) => assert.equal(await exists(join(p, "target", "one.txt")), true),
  );
  await run(
    "Bash git clean -f",
    shell,
    "git init -q && git clean -f",
    (p) => seed(p),
    async (p) => assert.equal(await exists(join(p, "one.txt")), false),
  );
  await run(
    "Bash git clean -fn",
    shell,
    "git init -q && git clean -fn",
    (p) => seed(p),
    async (p) => assert.equal(await exists(join(p, "one.txt")), true),
  );
  if (process.platform === "win32") {
    await run(
      "Git Bash robocopy /MIR",
      shell,
      "robocopy src dst /MIR /R:0 /W:0",
      async (p) => {
        await mkdir(join(p, "src"));
        await seed(join(p, "dst"));
      },
      async (p) => assert.equal(await exists(join(p, "dst", "one.txt")), false),
    );
    for (const listOnly of [false, true]) {
      await run(
        `Git Bash Robocopy absolute drive paths${listOnly ? " list-only" : ""}`,
        shell,
        (p) => {
          // 用实际临时目录构造 Git Bash 盘符路径；仅保留开关不转换，路径由 MSYS 转给 Robocopy。
          const drivePath = p
            .replaceAll("\\", "/")
            .replace(/^([a-z]):\//i, (_, drive) => `/${drive.toLowerCase()}/`);
          const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
          return `env -u MSYS_NO_PATHCONV 'MSYS2_ARG_CONV_EXCL=/MIR;/L' robocopy ${quote(`${drivePath}/src`)} ${quote(`${drivePath}/dst`)} /MIR${listOnly ? " /L" : ""}`;
        },
        async (p) => {
          await mkdir(join(p, "src"));
          await seed(join(p, "dst"));
        },
        async (p) => assert.equal(await exists(join(p, "dst", "one.txt")), listOnly),
      );
    }
  }
  console.log(JSON.stringify({ platform: process.platform, root, passed: results }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
