import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSessionMailboxAdapter } from "../src/mailbox/index.js";

describe("NodeSessionMailboxAdapter", () => {
  it("drains unread messages to read", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-"));
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    const messageId = "mailbox-message-1";
    const unreadDir = join(rootDir, "sess_target", "unread");
    const unreadPath = join(unreadDir, `${messageId}.json`);
    await mkdir(unreadDir, { recursive: true });
    await writeFile(
      unreadPath,
      `${JSON.stringify(
        {
          version: 1,
          messageId,
          fromSessionId: "sess_source",
          toSessionId: "sess_target",
          content: "hello",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(stat(unreadPath)).resolves.toBeTruthy();

    const drained = await mailbox.drainUnread({ sessionId: "sess_target" });

    expect(drained).toEqual([
      expect.objectContaining({
        messageId,
        fromSessionId: "sess_source",
        toSessionId: "sess_target",
        content: "hello",
      }),
    ]);
    await expect(stat(unreadPath)).rejects.toBeTruthy();
    const readPath = join(rootDir, "sess_target", "read", `${messageId}.json`);
    await expect(readFile(readPath, "utf8")).resolves.toContain("hello");
  });

  it("rejects session ids that would escape the mailbox root", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-parent-"));
    const rootDir = join(parentDir, "mailbox", "root");
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });

    await expect(mailbox.drainUnread({ sessionId: "../escaped-target" as never })).rejects.toThrow(
      "Invalid session id",
    );
    await expect(stat(resolve(rootDir, "..", "escaped-target"))).rejects.toBeTruthy();
  });
});
