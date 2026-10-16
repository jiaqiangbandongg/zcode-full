import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserTabRecoveryStore,
  type BrowserTabPageStateRecord,
  type BrowserTabShellRecord,
} from "../src/main/browserView/browserTabRecoveryStore.js";

const temporaryDirectories: string[] = [];

async function createStore(options?: { maxPageStates?: number; maxTotalBytes?: number }) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-browser-recovery-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "browser-tab-recovery.json");
  return {
    filePath,
    store: new BrowserTabRecoveryStore(filePath, options),
  };
}

function shell(
  tabId: string,
  overrides: Partial<BrowserTabShellRecord> = {},
): BrowserTabShellRecord {
  return {
    schemaVersion: 1,
    tabId,
    windowBindingId: null,
    workspaceKey: "workspace-a",
    sessionId: "session-a",
    origin: "user",
    lifecycle: "active",
    restoreUrl: `https://example.com/${tabId}`,
    title: tabId,
    faviconUrl: null,
    viewport: null,
    openedAt: 1,
    lastSelectedAt: null,
    updatedAt: 1,
    ...overrides,
  };
}

function pageState(
  tabId: string,
  overrides: Partial<BrowserTabPageStateRecord> = {},
): BrowserTabPageStateRecord {
  return {
    schemaVersion: 1,
    tabId,
    entries: [{ url: `https://example.com/${tabId}`, title: tabId }],
    activeIndex: 0,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("BrowserTabRecoveryStore", () => {
  it("BTL09: page-state 数量淘汰不连带删除无限 shell catalog", async () => {
    const { store } = await createStore({ maxPageStates: 2 });
    for (let index = 0; index < 3; index += 1) {
      await store.upsert(shell(`tab-${index}`, { updatedAt: index }));
      await store.upsertPageState(pageState(`tab-${index}`, { updatedAt: index }));
    }

    expect(
      (await store.listShells({ workspaceKey: "workspace-a" })).map((item) => item.tabId),
    ).toEqual(["tab-0", "tab-1", "tab-2"]);
    expect((await store.readSnapshot()).pageStates.map((item) => item.tabId)).toEqual([
      "tab-2",
      "tab-1",
    ]);
  });

  it("BTL09: 单页 history 截断到上限时保留 active entry 并重映射 index", async () => {
    const { store } = await createStore();
    const entries = Array.from({ length: 510 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: String(index),
      pageState: `state-${index}`,
    }));
    await store.upsertPageState(
      pageState("history", {
        entries,
        activeIndex: 507,
      }),
    );

    const restored = await store.getPageState("history");
    expect(restored?.entries).toHaveLength(500);
    expect(restored?.entries[restored.activeIndex]?.url).toBe("https://example.com/507");
    expect(restored?.activeIndex).toBeGreaterThanOrEqual(0);
    expect(restored?.activeIndex).toBeLessThan(500);
  });

  it("BTL09: 总字节超限从 updatedAt 最旧记录开始淘汰", async () => {
    const { store } = await createStore({ maxTotalBytes: 900 });
    await store.upsertPageState(
      pageState("old", {
        entries: [{ url: "https://example.com/old", pageState: "x".repeat(500) }],
        updatedAt: 1,
      }),
    );
    await store.upsertPageState(
      pageState("new", {
        entries: [{ url: "https://example.com/new", pageState: "y".repeat(500) }],
        updatedAt: 2,
      }),
    );

    expect((await store.readSnapshot()).pageStates.map((item) => item.tabId)).toEqual(["new"]);
  });

  it("BTL21: 单条超限快照不会先淘汰其它 tab 的正常快照", async () => {
    const { store } = await createStore({ maxTotalBytes: 900 });
    await store.upsert(shell("stable"));
    await store.upsertPageState(
      pageState("stable", {
        entries: [{ url: "https://example.com/stable", pageState: "x".repeat(200) }],
        updatedAt: 1,
      }),
    );
    await store.upsert(shell("oversized"));
    await store.upsertPageState(
      pageState("oversized", {
        entries: [{ url: "https://example.com/oversized", pageState: "y".repeat(1_200) }],
        updatedAt: 2,
      }),
    );

    const snapshot = await store.readSnapshot();
    expect(snapshot.pageStates.map((item) => item.tabId)).toEqual(["stable"]);
    expect(snapshot.shells.map((item) => item.tabId)).toEqual(["stable", "oversized"]);
  });

  it("BTL21: 同一 tab 的新快照变为超限时只删除自己的旧重量快照", async () => {
    const { store } = await createStore({ maxTotalBytes: 900 });
    await store.upsertPageState(
      pageState("updated", {
        entries: [{ url: "https://example.com/updated", pageState: "old" }],
        updatedAt: 1,
      }),
    );
    await store.upsertPageState(
      pageState("other", {
        entries: [{ url: "https://example.com/other", pageState: "safe" }],
        updatedAt: 2,
      }),
    );
    await store.upsertPageState(
      pageState("updated", {
        entries: [{ url: "https://example.com/updated", pageState: "z".repeat(1_200) }],
        updatedAt: 3,
      }),
    );

    expect((await store.readSnapshot()).pageStates.map((item) => item.tabId)).toEqual(["other"]);
  });

  it("BTL21: 单条超限快照不占用 page-state 数量名额", async () => {
    const { store } = await createStore({ maxPageStates: 2, maxTotalBytes: 900 });
    await store.upsertPageState(pageState("old", { updatedAt: 1 }));
    await store.upsertPageState(pageState("new", { updatedAt: 2 }));
    await store.upsertPageState(
      pageState("oversized", {
        entries: [{ url: "https://example.com/oversized", pageState: "z".repeat(1_200) }],
        updatedAt: 3,
      }),
    );

    expect((await store.readSnapshot()).pageStates.map((item) => item.tabId)).toEqual([
      "new",
      "old",
    ]);
  });

  it("BTL10: workspaceIdentity fallback key 与 remoteSessionId 共同隔离恢复查询", async () => {
    const { store } = await createStore();
    await store.upsert(
      shell("remote-a", {
        workspaceKey: "ssh://host-a/repo",
        remoteSessionId: "r1",
      }),
    );
    await store.upsert(
      shell("remote-b", {
        workspaceKey: "ssh://host-b/repo",
        remoteSessionId: "r2",
      }),
    );

    expect(
      (
        await store.listShells({
          workspaceKey: "ssh://host-a/repo",
          remoteSessionId: "r1",
        })
      ).map((item) => item.tabId),
    ).toEqual(["remote-a"]);
    expect(
      await store.listShells({
        workspaceKey: "ssh://host-a/repo",
        remoteSessionId: "r2",
      }),
    ).toEqual([]);
  });

  it("BTL11: 显式关闭原子删除 shell 与 page-state", async () => {
    const { store } = await createStore();
    await store.upsert(shell("closed"));
    await store.upsertPageState(pageState("closed"));

    await store.remove("closed");

    expect(await store.getShell("closed")).toBeNull();
    expect(await store.getPageState("closed")).toBeNull();
  });

  it("损坏文件隔离后从空仓库启动，后续写入仍使用原子替换", async () => {
    const { filePath, store } = await createStore();
    await writeFile(filePath, "{broken", "utf8");

    expect(await store.readSnapshot()).toEqual({
      schemaVersion: 1,
      shells: [],
      pageStates: [],
    });
    await store.upsert(shell("recovered"));

    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      shells: [{ tabId: "recovered" }],
    });
  });
});
