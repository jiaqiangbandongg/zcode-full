const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const mode = process.argv[2];
const label = process.argv[3] || mode;
const mark = (name, value = "ready") => fsp.writeFile(path.join(root, name), value);
const write = (text, fd = 1) => fs.writeSync(fd, text);

async function gate(name) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(root, name))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`unreleased gate: ${name}`);
}

async function main() {
  await mark(`${label}.pid`, String(process.pid));
  if (mode === "small") {
    write("BDO_中文_STDOUT");
    write("|中文_STDERR", 2);
    return;
  }
  if (mode === "empty-error") {
    process.exitCode = 7;
    return;
  }
  if (mode === "realtime") {
    for (let stage = 1; stage <= 5; stage++) {
      // 不带换行，并分别写两流；只有 E2E 已看到本段预览后才放行下一段/退出。
      const writtenAt = Date.now();
      if (stage > 1) write(`line-${stage} abcdefghijklmnop\n`.repeat(80));
      write(`实时-${stage}-stdout`);
      write(`|实时-${stage}-stderr`, 2);
      await mark(`realtime.${stage}.ready`, String(writtenAt));
      await gate(`realtime.${stage}.release`);
    }
    return;
  }
  if (mode === "large") {
    write("BDO_HEAD\n");
    const chunk = Buffer.alloc(1024 * 1024, "x");
    for (let n = 0; n < 65; n++) write(chunk);
    write("\nBDO_TAIL\n");
    return;
  }
  if (mode === "progress") {
    for (let n = 1; n <= 500; n++) write(`${label}-line-${n}-abcdefghijklmnopqrstuvwxyz\n`);
    write(`${label}-STAGE1`);
    await gate(`${label}.release`);
    if (label === "B") {
      write("\nB-STAGE2");
      await gate("B.finish");
    }
    return;
  }
  if (mode === "query") {
    write("BDO_QUERY_HEAD\n" + "x".repeat(300000) + "\nBDO_QUERY_FIRST_TAIL");
    await mark("query.ready");
    await gate("query.grow");
    write("y".repeat(300000) + "BDO_QUERY_SECOND_TAIL");
    await mark("query.grown");
    await gate("query.release");
    write("\nBDO_QUERY_FINAL_TAIL");
    return;
  }
  if (mode === "limit") {
    // 真正向继承的 stdout fd 写 5 GiB，不通过 truncate/sparse 文件代替输出。
    const chunk = Buffer.alloc(1024 * 1024, "x");
    for (let n = 0; n < 5 * 1024; n++) write(chunk);
    await mark(`${label}.ready`);
    await gate(`${label}.release`);
    write("!");
    await mark(`${label}.exceeded`);
    await gate(`${label}.finish`);
    return;
  }
  write("BDO_READ_FAILURE_READY");
  await mark("read-failure.ready");
  await gate("read-failure.release");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 9;
});
