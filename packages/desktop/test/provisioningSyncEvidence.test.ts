import { describe, expect, it } from "vitest";
import { parseProvisioningSyncEvents } from "./e2e/helpers/provisioning-sync-evidence.js";

const context = {
  environmentKey: "env-a",
  trigger: "personal-config",
  status: "failed",
  durationMs: 14,
};
const warning = `[2026-09-25 00:10:00] [warn] [pid:123] [main] [provider-provisioning] Environment sync did not apply ${JSON.stringify(context)}`;

describe("真实 Main Provisioning 结果取证", () => {
  it("保留成功与失败两类事件，供提交数和返回数对账", () => {
    const completed = warning
      .replace("[warn]", "[info]")
      .replace("sync did not apply", "sync completed")
      .replace('"status":"failed"', '"status":"applied"');
    expect(parseProvisioningSyncEvents(`${completed}\n${warning}\n`)).toEqual([
      { kind: "completed", ...context, status: "applied" },
      { kind: "warning", ...context },
    ]);
  });

  it("识别结构化 warning，不把 renderer 转述算成 Main 执行结果", () => {
    expect(
      parseProvisioningSyncEvents(`${warning}\n${warning.replace("[main]", "[renderer]")}\n`),
    ).toEqual([{ kind: "warning", ...context }]);
  });

  it("完成日志与失败状态矛盾时拒绝取证，不能伪装成已应用", () => {
    const wrong = warning
      .replace("[warn]", "[info]")
      .replace("sync did not apply", "sync completed");
    expect(() => parseProvisioningSyncEvents(`${wrong}\n`)).toThrow();
  });

  it("仅忽略正在追加的末行，完整写入后保留真实事件", () => {
    expect(parseProvisioningSyncEvents(warning)).toEqual([]);
    expect(parseProvisioningSyncEvents(`${warning}\n`)).toHaveLength(1);
  });

  it("缺少 Environment 身份的完整记录必须报错", () => {
    expect(() =>
      parseProvisioningSyncEvents(`${warning.replace('"environmentKey":"env-a",', "")}\n`),
    ).toThrow();
  });
});
