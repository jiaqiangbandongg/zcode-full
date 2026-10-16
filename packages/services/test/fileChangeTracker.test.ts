import { describe, expect, it } from "vitest";
import { SessionFileChangeTracker } from "../src/session/fileChangeTracker.js";

describe("SessionFileChangeTracker", () => {
  it("记录单轮单文件写入", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.newTurn();
    tracker.record("/a.ts", "old", "new");

    const changes = tracker.getChangesForTurn(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      path: "/a.ts",
      beforeContent: "old",
      afterContent: "new",
      writeCount: 1,
    });
  });

  it("同一文件同轮多次修改，合并首尾", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.newTurn();
    tracker.record("/a.ts", "v0", "v1");
    tracker.record("/a.ts", "v1", "v2");
    tracker.record("/a.ts", "v2", "v3");

    const changes = tracker.getChangesForTurn(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.beforeContent).toBe("v0");
    expect(changes[0]!.afterContent).toBe("v3");
    expect(changes[0]!.writeCount).toBe(3);
  });

  it("新文件 beforeContent 为 null", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.newTurn();
    tracker.record("/new.ts", null, "content");

    const changes = tracker.getChangesForTurn(0);
    expect(changes[0]!.beforeContent).toBeNull();
    expect(changes[0]!.afterContent).toBe("content");
  });

  it("多轮记录互不干扰", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.newTurn();
    tracker.record("/a.ts", "v0", "v1");
    tracker.newTurn();
    tracker.record("/a.ts", "v1", "v2");
    tracker.record("/b.ts", null, "hello");

    expect(tracker.getChangesForTurn(0)).toHaveLength(1);
    expect(tracker.getChangesForTurn(1)).toHaveLength(2);

    const turn0 = tracker.getChangesForTurn(0);
    expect(turn0[0]!.afterContent).toBe("v1");

    const turn1 = tracker.getChangesForTurn(1);
    const aChange = turn1.find((s) => s.path === "/a.ts");
    expect(aChange!.beforeContent).toBe("v1");
    expect(aChange!.afterContent).toBe("v2");
  });

  it("getChangesAfterTurn 返回指定轮次之后的所有变更", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.newTurn(); // 0
    tracker.record("/a.ts", "v0", "v1");
    tracker.newTurn(); // 1
    tracker.record("/b.ts", null, "new");
    tracker.newTurn(); // 2
    tracker.record("/c.ts", "old", "new");

    const after0 = tracker.getChangesAfterTurn(0);
    expect(after0).toHaveLength(2);
    expect(after0.map((s) => s.path).sort()).toEqual(["/b.ts", "/c.ts"]);

    const after1 = tracker.getChangesAfterTurn(1);
    expect(after1).toHaveLength(1);
    expect(after1[0]!.path).toBe("/c.ts");

    const after2 = tracker.getChangesAfterTurn(2);
    expect(after2).toHaveLength(0);
  });

  it("getRewindOperations 计算回滚操作", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.newTurn(); // 0
    tracker.record("/a.ts", "original", "v1");
    tracker.newTurn(); // 1
    tracker.record("/a.ts", "v1", "v2");
    tracker.record("/b.ts", null, "new-file");
    tracker.newTurn(); // 2
    tracker.record("/a.ts", "v2", "v3");

    // 回到 turn 0：a.ts 应恢复到 v1（turn 0 的 afterContent），b.ts 应删除（null）
    const ops = tracker.getRewindOperations(0);
    expect(ops.get("/a.ts")).toBe("v1");
    expect(ops.get("/b.ts")).toBeNull();
  });

  it("getRewindOperations 处理跨轮同文件", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.newTurn(); // 0: 不动 a.ts
    tracker.record("/x.ts", null, "x");
    tracker.newTurn(); // 1
    tracker.record("/a.ts", "origin", "v1");
    tracker.newTurn(); // 2
    tracker.record("/a.ts", "v1", "v2");

    // 回到 turn 0：a.ts 在 turn 1 才出现，before 是 "origin"
    const ops = tracker.getRewindOperations(0);
    expect(ops.get("/a.ts")).toBe("origin");
    expect(ops.has("/x.ts")).toBe(false); // x.ts 在 turn 0，不在回滚范围
  });

  it("getAllChangedFiles 汇聚所有文件的原始和最终状态", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.newTurn();
    tracker.record("/a.ts", "v0", "v1");
    tracker.newTurn();
    tracker.record("/a.ts", "v1", "v2");
    tracker.record("/b.ts", null, "hello");

    const all = tracker.getAllChangedFiles();
    expect(all.get("/a.ts")).toEqual({ originalContent: "v0", finalContent: "v2" });
    expect(all.get("/b.ts")).toEqual({ originalContent: null, finalContent: "hello" });
  });

  it("未 newTurn 时 record 自动创建第一轮", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.record("/a.ts", "old", "new");

    expect(tracker.getCurrentTurnIndex()).toBe(0);
    expect(tracker.getChangesForTurn(0)).toHaveLength(1);
  });

  it("可以只恢复当前轮次游标而不生成空 fileChanges", () => {
    const tracker = new SessionFileChangeTracker();
    tracker.restoreCurrentTurnIndex(3);

    expect(tracker.getCurrentTurnIndex()).toBe(3);
    expect(tracker.getTurnCount()).toBe(0);
    expect(tracker.serialize()).toEqual([]);
  });

  describe("序列化/反序列化", () => {
    it("roundtrip 正确还原", () => {
      const tracker = new SessionFileChangeTracker();
      tracker.newTurn();
      tracker.record("/a.ts", "v0", "v1");
      tracker.record("/b.ts", null, "new");
      tracker.newTurn();
      tracker.record("/a.ts", "v1", "v2");

      const serialized = tracker.serialize();
      const restored = SessionFileChangeTracker.deserialize(serialized);

      expect(restored.getCurrentTurnIndex()).toBe(1);
      expect(restored.getTurnCount()).toBe(2);

      const turn0 = restored.getChangesForTurn(0);
      expect(turn0).toHaveLength(2);
      expect(turn0.find((s) => s.path === "/a.ts")!.afterContent).toBe("v1");

      const turn1 = restored.getChangesForTurn(1);
      expect(turn1).toHaveLength(1);
      expect(turn1[0]!.afterContent).toBe("v2");
    });

    it("空 tracker 序列化为空数组", () => {
      const tracker = new SessionFileChangeTracker();
      expect(tracker.serialize()).toEqual([]);

      const restored = SessionFileChangeTracker.deserialize([]);
      expect(restored.getCurrentTurnIndex()).toBe(-1);
      expect(restored.getTurnCount()).toBe(0);
    });
  });

  describe("truncateAfterTurn", () => {
    it("截断到指定轮次", () => {
      const tracker = new SessionFileChangeTracker();
      tracker.newTurn(); // 0
      tracker.record("/a.ts", "v0", "v1");
      tracker.newTurn(); // 1
      tracker.record("/b.ts", null, "new");
      tracker.newTurn(); // 2
      tracker.record("/c.ts", "old", "new");

      tracker.truncateAfterTurn(1);

      expect(tracker.getTurnCount()).toBe(2);
      expect(tracker.getCurrentTurnIndex()).toBe(1);
      expect(tracker.getChangesForTurn(2)).toHaveLength(0);
    });

    it("截断到 -1 清空所有", () => {
      const tracker = new SessionFileChangeTracker();
      tracker.newTurn();
      tracker.record("/a.ts", "old", "new");

      tracker.truncateAfterTurn(-1);

      expect(tracker.getTurnCount()).toBe(0);
      expect(tracker.getCurrentTurnIndex()).toBe(-1);
    });
  });

  it("getChangesForTurn 对不存在的轮次返回空", () => {
    const tracker = new SessionFileChangeTracker();
    expect(tracker.getChangesForTurn(999)).toEqual([]);
  });
});
