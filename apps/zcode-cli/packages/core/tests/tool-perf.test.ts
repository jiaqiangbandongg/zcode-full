import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  classifySafeCommandIdentity,
  commandHash,
} from "../src/tool/handlers/tool-perf.js";

describe("tool performance telemetry helpers", () => {
  it("classifies only the bounded command prefix so heredoc bodies do not skew category", () => {
    const command = `cat <<'EOF'\n${"x".repeat(20_000)}\nnpm test\nEOF`;

    expect(classifyCommand(command)).toBe("other");
  });

  it("uses a bounded command hash bucket for very large commands", () => {
    const prefix = `python <<'PY'\n${"p".repeat(6_000)}`;
    const suffix = `${"s".repeat(6_000)}\nPY`;
    const left = `${prefix}${"a".repeat(10_000)}${suffix}`;
    const right = `${prefix}${"b".repeat(10_000)}${suffix}`;

    expect(commandHash(left)).toBe(commandHash(right));
  });

  it("只暴露公开 Registry 中的单一可执行文件名", () => {
    expect(classifySafeCommandIdentity("/usr/bin/git status --short")).toEqual({
      count: 1,
      name: "git",
    });
    expect(classifySafeCommandIdentity("./customer-private-script --token secret")).toEqual({
      count: 1,
      name: "other",
    });
  });

  it("动态和复合命令只进入固定低基数桶", () => {
    expect(classifySafeCommandIdentity("git status && pnpm test")).toEqual({
      count: 2,
      name: "compound",
    });
    expect(classifySafeCommandIdentity("$PRIVATE_COMMAND --arg")).toMatchObject({
      name: "other",
    });
  });

  it("超长命令不进入完整 parser，也不伪造命令数量", () => {
    expect(classifySafeCommandIdentity(`git status # ${"x".repeat(9_000)}`)).toEqual({
      name: "other",
    });
  });
});
