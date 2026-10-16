const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const signScriptPath = resolve(__dirname, "../../../scripts/sign-windows.ps1");

async function sign(configuration) {
  if (configuration.isNest) {
    // Bugfix: electron-builder 会按 sha1/sha256 多次调用 Windows signer，
    // 但 vsigntool 这套封装本身会完成完整签名流程，重复再签只会增加不确定性。
    // 这里跳过嵌套签名，统一以首轮调用为准，避免同一文件被重复处理。
    return;
  }

  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      signScriptPath,
      "-FilePath",
      configuration.path,
    ],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `[sign-windows-hook] vsigntool failed for ${configuration.path} with code ${result.status ?? "unknown"}`,
    );
  }
}

module.exports = sign;
module.exports.sign = sign;
