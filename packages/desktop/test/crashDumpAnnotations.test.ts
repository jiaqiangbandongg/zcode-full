import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  extractCrashDumpAnnotations,
  parseV8SizeAnnotation,
  summarizeCrashDumpAnnotations,
} from "../src/main/crashDumpAnnotations.js";
import { buildCrashDumpFixture, CODE_SPACE_OOM_ANNOTATIONS } from "./crashDumpFixture.js";

describe("crashDumpAnnotations", () => {
  it("按 crashpad 长度前缀布局提取已知注解，忽略长度对不上的伪键", () => {
    const decoy = Buffer.from("rapid v8-oom-location=fake ptype junk", "latin1");
    const dump = buildCrashDumpFixture(CODE_SPACE_OOM_ANNOTATIONS, {
      leadingBytes: Buffer.concat([Buffer.from("MDMP   ", "latin1"), decoy]),
      trailingBytes: Buffer.from("  pid     ", "latin1"),
    });

    const annotations = extractCrashDumpAnnotations(dump);

    expect(annotations).toEqual(CODE_SPACE_OOM_ANNOTATIONS);
    expect(annotations["v8-oom-stack"]).toContain("catalogTree-BYrDsScn.js");
  });

  it("同一个键只取第一次出现的值，并容忍非 4 字节对齐的文件头", () => {
    const first = buildCrashDumpFixture(
      { "v8-oom-location": "CALL_AND_RETRY_LAST" },
      { leadingBytes: Buffer.from("xyz", "latin1") },
    );
    const second = buildCrashDumpFixture({ "v8-oom-location": "OTHER" });

    expect(extractCrashDumpAnnotations(Buffer.concat([first, second]))).toEqual({
      "v8-oom-location": "CALL_AND_RETRY_LAST",
    });
  });

  it("无注解或损坏输入返回空对象而不是抛错", () => {
    expect(extractCrashDumpAnnotations(Buffer.alloc(0))).toEqual({});
    expect(extractCrashDumpAnnotations(Buffer.from("v8-oom-", "latin1"))).toEqual({});
    const truncated = buildCrashDumpFixture({ "v8-oom-location": "CALL_AND_RETRY_LAST" });
    expect(extractCrashDumpAnnotations(truncated.subarray(0, truncated.length - 6))).toEqual({});
  });

  it("解析 V8 大小文本并按 1024 进位", () => {
    expect(parseV8SizeAnnotation("0B")).toBe(0);
    expect(parseV8SizeAnnotation("1023.94KB")).toBe(Math.round(1023.94 * 1024));
    expect(parseV8SizeAnnotation("256.00MB")).toBe(256 * 1024 * 1024);
    expect(parseV8SizeAnnotation("4096.00MB")).toBe(4096 * 1024 * 1024);
    expect(parseV8SizeAnnotation("5727%")).toBeNull();
    expect(parseV8SizeAnnotation(undefined)).toBeNull();
  });

  it("code cage 用尽时判定为 code_space_exhausted，并带上栈头与最后一条 GC 日志", () => {
    const summary = summarizeCrashDumpAnnotations(CODE_SPACE_OOM_ANNOTATIONS);

    expect(summary).toMatchObject({
      processType: "renderer",
      location: "CALL_AND_RETRY_LAST",
      oomKind: "code_space_exhausted",
      isMainIsolate: true,
      isolateCount: 5,
      codeCageSizeBytes: 256 * 1024 * 1024,
      codeCageFreeBytes: 0,
      codeCageLastAllocStatus: "ran out of reservation",
      codeSpaceBytes: Math.round(149.89 * 1024 * 1024),
      codeLargeObjectSpaceBytes: Math.round(40.34 * 1024 * 1024),
      oldSpaceBytes: Math.round(284.93 * 1024 * 1024),
      mainCageLastAllocStatus: "success",
    });
    expect(summary?.stackHead).toEqual([
      "next",
      "WI in file:///Applications/ZCode.app/Contents/Resources/app.asar/out/renderer/assets/catalogTree-BYrDsScn.js",
      "kq in file:///Applications/ZCode.app/Contents/Resources/app.asar/out/renderer/assets/styles-DyAcaLKy.js",
      "Aq in =",
    ]);
    expect(summary?.lastGcMessage).toContain("189710714 ms: Mark-Compact (reduce)");
  });

  it("old-space 撞上限的普通堆 OOM 判定为 js_heap_exhausted", () => {
    const summary = summarizeCrashDumpAnnotations({
      "v8-oom-location": "CALL_AND_RETRY_LAST",
      "v8-oom-code-cage-size": "256.00MB",
      "v8-oom-code-cage-free-size": "200.00MB",
      "v8-oom-code-cage-last-alloc-status": "success",
      "v8-oom-main-cage-last-alloc-status": "success",
      "v8-oom-old-space-size": "3900.00MB",
    });

    expect(summary?.oomKind).toBe("js_heap_exhausted");
  });

  it("信息不足时 oomKind 为 unknown；没有 v8-oom-location 则不是 V8 OOM", () => {
    expect(summarizeCrashDumpAnnotations({ "v8-oom-location": "NewArray" })?.oomKind).toBe(
      "unknown",
    );
    expect(summarizeCrashDumpAnnotations({ process_type: "gpu-process" })).toBeNull();
  });
});
