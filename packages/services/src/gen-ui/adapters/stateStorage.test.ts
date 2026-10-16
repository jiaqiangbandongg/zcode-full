import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGenUiStateStorage } from "./stateStorage.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe("desktop Gen UI state persistence", () => {
  it("keeps the latest 100 paths and serializes writes across service instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const a = createGenUiStateStorage(root),
      b = createGenUiStateStorage(root);
    cleanup.push(
      () => a.dispose(),
      () => b.dispose(),
    );
    const scope = { workspacePath: "/workspace", sessionId: "task" };
    for (let i = 0; i < 102; i++)
      await (i % 2 ? a : b).set(
        { ...scope, path: `/workspace/view-${i}.html` },
        { modelContent: i, privateContent: null },
      );
    const entries = await b.list(scope);
    expect(entries).toHaveLength(100);
    expect(entries.some((entry) => entry.path === "/workspace/view-101.html")).toBe(true);
    expect(await a.get({ ...scope, path: "/workspace/view-0.html" })).toBeNull();
  });
  it("restores across service instances and serializes complete snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const first = createGenUiStateStorage(root),
      second = createGenUiStateStorage(root);
    cleanup.push(
      () => first.dispose(),
      () => second.dispose(),
    );
    const target = {
      workspacePath: "/workspace",
      sessionId: "task",
      path: "/workspace/chart.html",
    };
    await Promise.all(
      [1, 2, 3].map((tab) => first.set(target, { modelContent: null, privateContent: { tab } })),
    );
    expect(await second.get(target)).toEqual({ modelContent: null, privateContent: { tab: 3 } });
    expect(await second.get({ ...target, workspaceIdentity: "remote-example" })).toBeNull();
    await second.set(target, { modelContent: { year: 2026 }, privateContent: null });
    expect(await first.get(target)).toEqual({ modelContent: { year: 2026 }, privateContent: null });
  });
  it("broadcasts external writes without echo loops", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const a = createGenUiStateStorage(root),
      b = createGenUiStateStorage(root);
    cleanup.push(
      () => a.dispose(),
      () => b.dispose(),
    );
    const target = {
      workspacePath: "/workspace",
      sessionId: "task",
      path: "/workspace/chart.html",
    };
    await a.get(target);
    const changed = new Promise<unknown>((resolve) => {
      const off = a.onChanged((event) => {
        off.dispose();
        resolve(event.state);
      });
    });
    await b.set(target, { modelContent: "selection", privateContent: null });
    expect(await changed).toEqual({ modelContent: "selection", privateContent: null });
  });
});
