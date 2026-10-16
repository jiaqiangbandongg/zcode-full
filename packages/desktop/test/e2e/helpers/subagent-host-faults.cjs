// 仅由 E2E 给第二个 Electron UtilityProcess 预加载；生产入口不引用此文件。
// 替换文件边界，不替换缓存、配置服务、RPC handler 或 CLI 执行对象。
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { join } = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const root = process.env.ZCODE_E2E_HOST_FAULT_ROOT;
const controlPath = join(root, "host-fault-control.json");
const logPath = join(root, `host-boundary-${process.pid}.jsonl`);
const control = () => JSON.parse(fs.readFileSync(controlPath, "utf8"));
const log = (event) =>
  fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...event }) + "\n");
const consumed = new Set();
const readCounts = new Map();
function released(id) {
  return control().released?.includes(id);
}
function waitForRelease(id) {
  return new Promise((resolve) => {
    const watcher = fs.watch(root, () => {
      if (released(id)) {
        watcher.close();
        resolve();
      }
    });
    if (released(id)) {
      watcher.close();
      resolve();
    }
  });
}
for (const operation of ["readFile", "readdir", "writeFile"]) {
  const original = fsp[operation];
  fsp[operation] = async function (path, ...args) {
    if (control().tracePaths?.includes(String(path))) {
      if (operation === "readFile")
        readCounts.set(String(path), (readCounts.get(String(path)) ?? 0) + 1);
      log({
        kind: "file-called",
        operation,
        path: String(path),
        paths: [String(path)],
        stack: new Error().stack,
      });
    }
    // 目录扫描故障只拦配置读取；watcher 自身的枚举另有监听异常语义，不能一起阻断事件源。
    const watcherScan = operation === "readdir" && /ReaddirpStream/.test(new Error().stack ?? "");
    const rule = control().files?.find(
      (r) =>
        !watcherScan &&
        r.operation === operation &&
        String(path) === r.path &&
        (!r.once || !consumed.has(r.id)),
    );
    if (!rule) return original.call(this, path, ...args);
    consumed.add(rule.id);
    if (rule.action === "fail") {
      log({ kind: "file-failed", id: rule.id, operation, path: String(path) });
      throw Object.assign(new Error(`E2E ${operation} failed`), { code: "EACCES" });
    }
    const result = await original.call(this, path, ...args);
    log({ kind: "file-held", id: rule.id, operation, path: String(path) });
    await waitForRelease(rule.id);
    log({ kind: "file-released", id: rule.id });
    if (rule.rejectAfterRelease) throw new Error("E2E stale read rejected");
    return result;
  };
}
syncBuiltinESMExports();
// 只观察既有 Host 日志通道，将文件读取序号与随后完成的批次关联；不改写消息或缓存。
const post = process.parentPort.postMessage.bind(process.parentPort);
process.parentPort.postMessage = (...args) => {
  const [frame] = args;
  if (
    frame?.source === "host" &&
    typeof frame.message === "string" &&
    frame.message.includes("Subagent 配置文件更新完成")
  ) {
    // 与 Host 日志的 JSON 转义保持一致，否则 Windows 路径会漏记已完成的更新。
    const paths = (control().tracePaths ?? []).filter((path) =>
      frame.message.includes(JSON.stringify(path).slice(1, -1)),
    );
    if (paths.length)
      log({ kind: "snapshot-published", paths, readCounts: Object.fromEntries(readCounts) });
  }
  return post(...args);
};
log({ kind: "ready" });
// UtilityProcess 不执行 Node --require 参数：测试启动器加载边界后进入原 Host 模块。
void import(require("node:url").pathToFileURL(process.argv[2]).href);
