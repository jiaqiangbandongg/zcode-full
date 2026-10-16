import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { commitPermissionFullAccess } from "../src/storage/session-store/repositories/permission-full-access.js";
import type { SessionId } from "@zcode/contracts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT, payload TEXT, status TEXT, time_updated INTEGER);
  `);
  const original = {
    text: "hello",
    intent: { mode: "edit", planEnabled: true },
    conversationInputIntent: {
      mode: "edit",
      planEnabled: true,
      attachments: ["a"],
      order: { admissionSeq: 7 },
    },
  };
  for (const [id, session, status] of [
    ["a", "s", "admitted"],
    ["other", "other", "admitted"],
    ["done", "s", "promoted"],
  ]) {
    db.prepare("insert into session_input values (?, ?, ?, ?, 0)").run(
      id!,
      session!,
      JSON.stringify(original),
      status!,
    );
  }
  const entry = (id: string, data: unknown) => ({
    id,
    sessionID: "s" as SessionId,
    type: "runtime/execution_state",
    touchSession: false,
    time: { created: 1, updated: 1 },
    data,
  });
  const input = {
    sessionID: "s" as SessionId,
    queueItemIds: ["a"],
    execution: entry("execution", { mode: "yolo", planEnabled: true }),
    receipt: {
      ...entry("receipt", { interactionId: "p" }),
      type: "runtime/permission_full_access",
    },
  };
  const read = (id: string) =>
    JSON.parse(
      db.prepare("select payload from session_input where id = ?").get(id)!.payload as string,
    );
  return { db, input, read, original };
}

describe("完全访问 SQLite 原子提交", () => {
  it("仅指定任务和队列权限改变，重复 receipt 不扩大目标", async () => {
    const { db, input, read, original } = fixture();
    try {
      await commitPermissionFullAccess(db, input);
      expect(read("a")).toEqual({
        ...original,
        intent: { ...original.intent, mode: "yolo" },
        conversationInputIntent: { ...original.conversationInputIntent, mode: "yolo" },
      });
      expect(read("other")).toEqual(original);
      expect(read("done")).toEqual(original);
      await commitPermissionFullAccess(db, { ...input, queueItemIds: ["other"] });
      expect(read("other")).toEqual(original);
    } finally {
      db.close();
    }
  });
  it("最后的 receipt 保存失败时回滚 execution 和队列", async () => {
    const { db, input, read, original } = fixture();
    try {
      db.exec(
        "CREATE TRIGGER fail_receipt BEFORE INSERT ON session_entry WHEN NEW.id = 'receipt' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
      );
      await expect(commitPermissionFullAccess(db, input)).rejects.toThrow("disk full");
      expect(read("a")).toEqual(original);
      expect(db.prepare("select count(*) as n from session_entry").get()!.n).toBe(0);
    } finally {
      db.close();
    }
  });
  it("过期/跨任务队列项拒绝整个提交", async () => {
    const { db, input, read, original } = fixture();
    try {
      await expect(
        commitPermissionFullAccess(db, { ...input, queueItemIds: ["a", "other"] }),
      ).rejects.toThrow("unavailable");
      expect(read("a")).toEqual(original);
      const controller = new AbortController();
      controller.abort();
      await expect(
        commitPermissionFullAccess(db, { ...input, signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});
