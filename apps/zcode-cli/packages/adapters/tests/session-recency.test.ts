import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createProjectId,
  createSessionId,
  type ModelId,
  type ModelProviderId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

describe("SQLite session recency", () => {
  it("uses recent message activity when listing resumable sessions", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-store-latest-"));
    const store = createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const olderSessionID = createSessionId("older-activity");
    const newerSessionID = createSessionId("newer-activity");

    try {
      await store.createSession({
        id: olderSessionID,
        projectID: createProjectId("latest-order"),
        slug: "older-activity",
        directory: tempRoot,
        title: "older",
        version: "0.1.0",
        time: {
          created: 1_000,
          updated: 1_000,
        },
      });
      await store.createSession({
        id: newerSessionID,
        projectID: createProjectId("latest-order"),
        slug: "newer-activity",
        directory: tempRoot,
        title: "newer",
        version: "0.1.0",
        time: {
          created: 2_000,
          updated: 2_000,
        },
      });

      await store.saveMessage({
        id: createMessageId("older-late-message"),
        sessionID: olderSessionID,
        role: "user",
        time: {
          created: 3_000,
        },
        agent: "zcode-agent",
        model: {
          providerID: "test-provider" as ModelProviderId,
          modelID: "test-model" as ModelId,
        },
      });

      const sessions = await store.listSessions({
        directory: tempRoot,
        roots: true,
      });

      expect(sessions.map((session) => session.id)).toEqual([olderSessionID, newerSessionID]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
