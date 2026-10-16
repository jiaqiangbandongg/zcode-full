import { describe, expect, it } from "vitest";
import {
  LAUNCH_MARKS_QUERY_KEY,
  parseLaunchMarks,
  serializeLaunchMarks,
} from "../src/launchMarks.js";

describe("launchMarks", () => {
  const marks = { createdAt: 1000, mainStart: 1100, appReady: 1300, loadUrl: 1500 };

  it("round-trips through serialize/parse", () => {
    expect(parseLaunchMarks(serializeLaunchMarks(marks))).toEqual(marks);
  });

  it("query key 常量稳定", () => {
    expect(LAUNCH_MARKS_QUERY_KEY).toBe("zcodeLaunchMarks");
  });

  it("非法输入返回 null", () => {
    expect(parseLaunchMarks(null)).toBeNull();
    expect(parseLaunchMarks(undefined)).toBeNull();
    expect(parseLaunchMarks("not-json")).toBeNull();
    expect(parseLaunchMarks(JSON.stringify({ createdAt: 1 }))).toBeNull();
  });

  it("字段非数字返回 null", () => {
    expect(
      parseLaunchMarks(JSON.stringify({ createdAt: "x", mainStart: 1, appReady: 1, loadUrl: 1 })),
    ).toBeNull();
  });
});
