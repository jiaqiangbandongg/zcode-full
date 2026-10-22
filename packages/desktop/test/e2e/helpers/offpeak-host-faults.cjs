// 仅由 E2E Host 启动器加载：在真实 CLI stdio 边界模拟已安装新票但确认失败。
const { appendFile } = require("node:fs/promises");
const { join } = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const { StringDecoder } = require("node:string_decoder");
const childProcess = require("node:child_process");
const logPath = join(process.env.ZCODE_E2E_HOST_FAULT_ROOT, `host-boundary-${process.pid}.jsonl`);
let logWrites = Promise.resolve();
const log = (kind, id) => {
  logWrites = logWrites.then(() => appendFile(logPath, JSON.stringify({ kind, id }) + "\n"));
};
const spawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  if (!child.stdin || !child.stdout) return child;
  const controls = new Map();
  const completed = [];
  let failed = false;
  let confirmed = false;
  let executionId;
  const write = child.stdin.write;
  child.stdin.write = function (chunk, ...rest) {
    for (const line of String(chunk).split("\n")) {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        frame.method !== "v4/conversation/offPeakControl" ||
        frame.params?.action !== "replace_ticket"
      )
        continue;
      executionId = frame.params.executionId;
      const id = `${executionId}/${frame.params.renewalId}/${frame.params.ticketId}`;
      controls.set(frame.id, id);
      log("ticket-control", id);
    }
    return write.call(this, chunk, ...rest);
  };
  const emit = child.stdout.emit;
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  child.stdout.emit = function (event, chunk, ...rest) {
    if (event !== "data") return emit.call(this, event, chunk, ...rest);
    buffered += decoder.write(chunk);
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        emit.call(this, "data", Buffer.from(line + "\n"));
        continue;
      }
      // 保留完成通知直到交接得到确认，确保真实同步周期有机会修复未知回执。
      if (
        !confirmed &&
        executionId &&
        frame.method === "v4/offPeak/lifecycle" &&
        frame.params?.executionId === executionId &&
        frame.params.type === "completed"
      ) {
        completed.push(line);
        continue;
      }
      const id = controls.get(frame.id);
      if (id && frame.result?.accepted) {
        if (!failed) {
          failed = true;
          log("ticket-ack-failed", id);
          emit.call(
            this,
            "data",
            Buffer.from(
              JSON.stringify({
                id: frame.id,
                error: { code: -32000, message: "E2E ticket ACK unavailable after installation" },
              }) + "\n",
            ),
          );
          continue;
        }
        confirmed = true;
        log("ticket-ack-confirmed", id);
      }
      emit.call(this, "data", Buffer.from(line + "\n"));
      if (confirmed)
        for (const held of completed.splice(0)) emit.call(this, "data", Buffer.from(held + "\n"));
    }
    return true;
  };
  return child;
};
syncBuiltinESMExports();
log("ready");
void import(require("node:url").pathToFileURL(process.argv[2]).href);
