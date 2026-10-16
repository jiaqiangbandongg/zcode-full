import { ensureTelemetryDeviceMid } from "@zcode/services/node";

export interface EnsureRemoteServerDeviceMidOptions {
  /** 仅测试注入；生产固定使用 services 的 ensureTelemetryDeviceMid。 */
  ensureDeviceMid?: () => Promise<string>;
  log: (...args: unknown[]) => void;
}

/**
 * 远端 server 启动时确保所在主机拥有自己的 deviceMid。
 *
 * 远程工作区（SSH/WSL/Docker）里没有 Desktop main 进程，过去没有任何进程会在远端主机
 * 写设备身份文件，而 buildZCodeSourceHeaders() 只读不生成。3.12.0 起 Start Plan 权益由
 * 远端自己查询，billing/balance 请求因缺 X-Device-Mid 被服务端拒绝为 parameter error，远程工作区
 * 看不到 Start Plan 模型。Desktop main 通过 ensureDesktopDeviceMidSync 承担本地的这一职责，这里让
 * 远端 stdio entry 承担同一职责，复用同一个文件、字段与锁，与同机 zcode-cli 共享同一个设备身份。
 *
 * 失败不阻断启动：设备标识缺失只会让 ZCode endpoint 请求少一个 header（与修复前行为一致），
 * 远端 server 的其余能力不依赖它；这里记录 warn 并保留原因，不伪造设备 ID。
 */
export async function ensureRemoteServerDeviceMid(
  options: EnsureRemoteServerDeviceMidOptions,
): Promise<string | undefined> {
  const ensureDeviceMid = options.ensureDeviceMid ?? ensureTelemetryDeviceMid;
  try {
    return await ensureDeviceMid();
  } catch (error) {
    options.log(
      "telemetry deviceMid 初始化失败，ZCode endpoint 请求将不带 X-Device-Mid:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}
