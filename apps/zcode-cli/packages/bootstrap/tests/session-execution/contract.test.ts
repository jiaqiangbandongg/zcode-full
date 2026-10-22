import { describe, expect, it } from "vitest";
import {
  acquireSessionResidencyFinalization,
  runWithSessionResidencyFinalization,
  createModelExecutionContext,
} from "../../src/session-execution/index.js";

describe("协议无关的会话执行材料与收尾租约", () => {
  it("嵌套持有且重复释放时，仍只由原 record 维护计数", () => {
    const record = { residencyFinalizationCount: 0 };
    const releaseFirst = acquireSessionResidencyFinalization(record);
    const releaseSecond = acquireSessionResidencyFinalization(record);
    expect(record.residencyFinalizationCount).toBe(2);
    releaseFirst();
    releaseFirst();
    expect(record.residencyFinalizationCount).toBe(1);
    releaseSecond();
    expect(record.residencyFinalizationCount).toBe(0);
  });
  it.each(["success", "rejected", "thrown"])("执行 %s 后释放同一 owner 的租约", async (kind) => {
    const record = { residencyFinalizationCount: 0 };
    const failure = new Error("execution failed");
    const result = runWithSessionResidencyFinalization(record, () => {
      expect(record.residencyFinalizationCount).toBe(1);
      if (kind === "thrown") throw failure;
      return kind === "rejected" ? Promise.reject(failure) : Promise.resolve("done");
    });
    if (kind === "success") await expect(result).resolves.toBe("done");
    else await expect(result).rejects.toBe(failure);
    expect(record.residencyFinalizationCount).toBe(0);
  });
  it("每次执行使用独立的不可变鉴权材料快照", async () => {
    const headers = { Authorization: "test-credential" };
    const context = createModelExecutionContext({ requestAuth: { headers } });
    headers.Authorization = "changed";
    const auth = await context.requestDependencies!.requestAuth!.source.resolve({} as never);
    expect(auth.headers).toEqual({ Authorization: "test-credential" });
    expect(Object.isFrozen(auth)).toBe(true);
    expect(Object.isFrozen(auth.headers)).toBe(true);
    expect(context.selectionScope).toBe("execution");
  });
});
