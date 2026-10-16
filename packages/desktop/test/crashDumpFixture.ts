import { Buffer } from "node:buffer";

/**
 * 按 crashpad 的注解布局拼一个最小 dump：MinidumpUTF8String(name) + MinidumpByteArray(value)，
 * 都是 `u32 长度 + 内容`（name 额外带 NUL 结尾），按 4 字节对齐。
 */
export function buildCrashDumpFixture(
  annotations: Record<string, string>,
  options?: { leadingBytes?: Buffer; trailingBytes?: Buffer },
): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (chunk: Buffer): void => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  const alignTo4 = (): void => {
    const padding = (4 - (offset % 4)) % 4;
    if (padding > 0) {
      push(Buffer.alloc(padding));
    }
  };
  const pushUInt32 = (value: number): void => {
    const chunk = Buffer.alloc(4);
    chunk.writeUInt32LE(value);
    push(chunk);
  };

  push(options?.leadingBytes ?? Buffer.from("MDMP   ", "latin1"));
  for (const [key, value] of Object.entries(annotations)) {
    alignTo4();
    const keyBytes = Buffer.from(key, "latin1");
    pushUInt32(keyBytes.length);
    push(keyBytes);
    push(Buffer.alloc(1));
    alignTo4();
    const valueBytes = Buffer.from(value, "utf8");
    pushUInt32(valueBytes.length);
    push(valueBytes);
  }
  push(options?.trailingBytes ?? Buffer.alloc(0));
  return Buffer.concat(chunks);
}

/** 复刻 2026-09-12 macOS 3.11.2 白屏 dump 里的关键注解（code cage 耗尽型 OOM）。 */
export const CODE_SPACE_OOM_ANNOTATIONS: Record<string, string> = {
  process_type: "renderer",
  pid: "85886",
  "v8-oom-location": "CALL_AND_RETRY_LAST",
  "v8-oom-stack": [
    "next",
    "WI in file:///Applications/ZCode.app/Contents/Resources/app.asar/out/renderer/assets/catalogTree-BYrDsScn.js",
    "kq in file:///Applications/ZCode.app/Contents/Resources/app.asar/out/renderer/assets/styles-DyAcaLKy.js",
    "Aq in =",
  ].join("\n"),
  "v8-oom-last-few-messages": [
    "[85886:0x10c007c0000] 189710587 ms: Mark-Compact (reduce) 566.5 (598.3) -> 566.5 (597.6) MB, pooled: 0.0 MB, 122.54 / 0.01 ms (average mu = 0.061, current mu = 0.052) last resort; GC in old space requested",
    "[85886:0x10c007c0000] 189710714 ms: Mark-Compact (reduce) 566.5 (597.6) -> 566.5 (596.6) MB, pooled: 0.0 MB, 126.75 / 0.00 ms (average mu = 0.031, current mu = 0.001) last resort; GC in old space requested",
  ].join("\n"),
  "v8-oom-code-cage-last-alloc-status": "ran out of reservation",
  "v8-oom-code-cage-free-size": "0B",
  "v8-oom-code-cage-size": "256.00MB",
  "v8-oom-main-cage-last-alloc-status": "success",
  "v8-oom-main-cage-free-size": "3775.00MB",
  "v8-oom-trusted-cage-free-size": "905.00MB",
  "v8-oom-is-main-isolate": "true",
  "v8-oom-isolate-count": "5",
  "v8-oom-malloced-peak-memory": "289.04MB",
  "v8-oom-memory-allocator-size": "596.59MB",
  "v8-oom-code-lo-space-size": "40.34MB",
  "v8-oom-code-space-size": "149.89MB",
  "v8-oom-old-space-capacity": "291.73MB",
  "v8-oom-old-space-size": "284.93MB",
};
