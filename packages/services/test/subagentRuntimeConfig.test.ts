import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { EventEmitter, on } from "node:events";
import { watch } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as shared from "@zcode/shared";
import { createSubagentRuntimeConfigCache } from "../src/subagents/subagentRuntimeConfig.js";
import { createSubagentConfigScope } from "../src/subagents/subagentConfigScope.js";

const parentEvents = vi.hoisted(() => new Map<string, Set<EventEmitter>>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat),
    watch: vi.fn(async function* (path: string, options: { signal: AbortSignal }) {
      const emitter = new EventEmitter();
      if (!parentEvents.has(path)) parentEvents.set(path, new Set());
      parentEvents.get(path)!.add(emitter);
      try {
        for await (const [event] of on(emitter, "change", { signal: options.signal })) yield event;
      } finally {
        parentEvents.get(path)?.delete(emitter);
      }
    }),
  };
});
vi.mock("@zcode/shared", { spy: true });
const readiness = vi.hoisted(() => ({ automatic: true }));
const watched = vi.hoisted(() => new Set<EventEmitter>());
vi.mock("chokidar", () => ({
  watch: vi.fn(() => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
    watched.add(watcher);
    if (readiness.automatic) queueMicrotask(() => watcher.emit("ready"));
    return watcher;
  }),
}));
beforeEach(async () => {
  readiness.automatic = true;
  vi.mocked(watch).mockClear();
  vi.mocked(fs.watch).mockClear();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
  vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir);
  vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat);
  vi.mocked(shared.parseAgentProfileFromMarkdown).mockClear();
});
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  watched.clear();
  parentEvents.clear();
  vi.restoreAllMocks();
});
const markdown = (name: string, prompt = name) =>
  `---\nname: ${name}\ndescription: Test\n---\n${prompt}`;
const until = (assertion: () => unknown) => vi.waitFor(assertion, { timeout: 5000, interval: 10 });
function initialWatcherFor(path: string): ReturnType<typeof watch> {
  // 各 scope 并行 stat，注册顺序不固定；按监听路径取得初始实例，避免向其他 scope 发事件。
  const index = vi.mocked(watch).mock.calls.findIndex(([root]) => root === path);
  expect(index).toBeGreaterThanOrEqual(0);
  return vi.mocked(watch).mock.results[index]!.value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "subagent-snapshot-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const userRoot = join(root, "user"),
    statePath = join(root, "state", "agents-state.json");
  await mkdir(userRoot);
  await mkdir(join(root, "state"));
  const state = {
    disabledAgentIds: [] as string[],
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
  };
  const readState = vi.fn(async () => structuredClone(state));
  const cache = createSubagentRuntimeConfigCache({
    readUserRoot: async () => userRoot,
    readStatePath: async () => statePath,
    readState,
  });
  cleanup.push(() => cache.dispose());
  const workspace = { workspacePath: join(root, "workspace") };
  const emit = (path: string, event = "change", _rootPath = userRoot) =>
    [...watched].forEach((watcher) => watcher.emit("all", event, path));
  const read = () => cache.read(workspace);
  return { root, userRoot, statePath, state, readState, cache, workspace, emit, read };
}

describe("Host incremental subagent snapshots", () => {
  it("keeps the filesystem root observable when the configuration directory does not exist", async () => {
    // 使用当前平台的真实根路径，但 mock watcher，避免写入盘符根目录或监听整个文件系统。
    const volumeRoot = parse(resolve(tmpdir())).root;
    const parent = join(volumeRoot, `subagent-missing-${randomUUID()}`);
    const root = join(parent, "agents");
    const scope = createSubagentConfigScope({ root, load: async () => [], onSettled: vi.fn() });
    cleanup.push(() => scope.dispose());
    await scope.ready;
    const [anchor, options] = vi.mocked(watch).mock.calls.at(-1)!;
    expect(anchor).toBe(volumeRoot);
    const ignored = options?.ignored;
    if (typeof ignored !== "function") throw new Error("Expected watcher path filter");
    expect(ignored(volumeRoot)).toBe(false);
    expect(options?.depth).toBe(0);
    expect(ignored(parent, { isDirectory: () => true } as Stats)).toBe(false);
    expect(ignored(join(volumeRoot, "unrelated"), { isDirectory: () => true } as Stats)).toBe(
      false,
    );
    expect(
      ignored(join(volumeRoot, "unrelated.md"), {
        isDirectory: () => false,
        isSymbolicLink: () => false,
      } as Stats),
    ).toBe(true);
    expect(ignored(root)).toBe(true);
    expect(ignored(join(root, "reviewer.md"))).toBe(true);
  });

  it("switches missing ancestors to the original root and waits for stable initial files", async () => {
    const f = await fixture();
    await f.cache.prepare(f.workspace);
    const watchedPaths = vi.mocked(watch).mock.calls.map(([path]) => path);
    expect(watchedPaths.sort()).toEqual([f.userRoot, join(f.root, "state"), f.root].sort());
    const parentWatcher = initialWatcherFor(f.root);
    const project = join(f.workspace.workspacePath, ".zcode", "agents");
    await mkdir(project, { recursive: true });
    const path = join(project, "a.md"),
      temporary = join(project, "temporary.md");
    await writeFile(path, markdown("aaa", "partial"));
    await writeFile(temporary, markdown("temporary"));
    vi.mocked(fs.readFile).mockClear();
    vi.mocked(fs.readdir).mockClear();
    parentWatcher.emit("all", "addDir", f.workspace.workspacePath);
    await until(() => expect(vi.mocked(watch).mock.calls.at(-1)?.[0]).toBe(project));
    await until(() =>
      expect(
        vi.mocked(fs.stat).mock.calls.filter(([p]) => p === path).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(vi.mocked(fs.readFile).mock.calls.filter(([p]) => p === path)).toEqual([]);
    expect(await f.read()).toMatchObject({ profiles: [] });
    await writeFile(path, markdown("aaa", "complete"));
    await rm(temporary);
    const added = join(project, "b.markdown");
    await writeFile(added, markdown("bbb"));
    f.emit(added, "add");
    await until(async () =>
      expect(await f.read()).toMatchObject({
        profiles: [{ name: "aaa", systemPrompt: "complete" }, { name: "bbb" }],
      }),
    );
    expect(vi.mocked(fs.readFile).mock.calls.filter(([p]) => p === path)).toHaveLength(1);
    expect(vi.mocked(fs.readFile).mock.calls.filter(([p]) => p === temporary)).toHaveLength(0);
    expect(vi.mocked(fs.readdir).mock.calls.filter(([p]) => p === project)).toHaveLength(1);
    const reads = vi.mocked(fs.readFile).mock.calls.length;
    parentWatcher.emit("all", "change", path);
    await Promise.all([f.read(), f.read()]);
    expect(vi.mocked(fs.readFile).mock.calls.length).toBe(reads);
    expect((parentWatcher as unknown as { close: unknown }).close).toHaveBeenCalledOnce();
  });

  it("rechecks directory changes during watcher readiness and ignores unrelated parent events", async () => {
    readiness.automatic = false;
    const f = await fixture();
    const preparing = f.cache.prepare(f.workspace);
    await until(() => expect(watched.size).toBe(3));
    const project = join(f.workspace.workspacePath, ".zcode", "agents");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "a.md"), markdown("aaa"));
    for (const watcher of watched) watcher.emit("ready");
    await until(() => expect(watched.size).toBe(4));
    await rm(f.workspace.workspacePath, { recursive: true });
    [...watched].at(-1)!.emit("ready");
    await until(() => expect(watched.size).toBe(5));
    [...watched].at(-1)!.emit("ready");
    await preparing;
    expect(await f.read()).toMatchObject({ profiles: [] });
    vi.mocked(fs.readFile).mockClear();
    vi.mocked(fs.readdir).mockClear();
    const parent = [...watched].at(-1)!;
    parent.emit("all", "addDir", join(f.root, "unrelated"));
    await until(() => expect(vi.mocked(fs.stat).mock.calls.at(-1)?.[0]).toBe(f.root));
    expect(watched.size).toBe(5);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.readdir).not.toHaveBeenCalled();
  });

  it.each(["rebuild", "dispose"])(
    "cancels a recovered-directory load on %s without publishing its result",
    async (action) => {
      const f = await fixture();
      await f.cache.prepare(f.workspace);
      const project = join(f.workspace.workspacePath, ".zcode", "agents");
      const path = join(project, "a.md");
      await mkdir(project, { recursive: true });
      await writeFile(path, markdown("aaa", "discard"));
      f.emit(f.workspace.workspacePath, "addDir");
      await until(() => expect(vi.mocked(fs.stat).mock.calls.some(([p]) => p === path)).toBe(true));
      const obsolete = [...watched].at(-1)!;
      if (action === "dispose") {
        f.cache.dispose();
        await expect(f.read()).rejects.toThrow(/disposed/i);
      } else {
        await rm(project, { recursive: true });
        await mkdir(project);
        await writeFile(path, markdown("aaa", "latest"));
        obsolete.emit("all", "unlinkDir", project);
        await until(async () =>
          expect(await f.read()).toMatchObject({ profiles: [{ systemPrompt: "latest" }] }),
        );
        expect((obsolete as unknown as { close: unknown }).close).toHaveBeenCalledOnce();
      }
      expect(
        vi
          .mocked(shared.parseAgentProfileFromMarkdown)
          .mock.calls.some(([input]) => input.content.includes("discard")),
      ).toBe(false);
    },
  );

  it("discards an in-flight file read when its directory is replaced", async () => {
    const f = await fixture();
    const path = join(f.userRoot, "a.md");
    await writeFile(path, markdown("aaa", "initial"));
    await f.cache.prepare(f.workspace);
    const gate = Promise.withResolvers<string>();
    vi.mocked(fs.readFile).mockImplementationOnce(
      () => gate.promise as ReturnType<typeof fs.readFile>,
    );
    f.emit(path);
    await until(() => expect(vi.mocked(fs.readFile).mock.results.at(-1)?.value).toBe(gate.promise));
    const obsolete = initialWatcherFor(f.userRoot);
    await rm(f.userRoot, { recursive: true });
    await mkdir(f.userRoot);
    await writeFile(path, markdown("aaa", "replacement"));
    // 快速替换时可能只有原生事件；路径仍存在，也必须关闭旧目录对象的监听。
    for (const events of parentEvents.get(dirname(f.userRoot)) ?? [])
      events.emit("change", { eventType: "rename", filename: "user" });
    await until(() =>
      expect((obsolete as unknown as { close: unknown }).close).toHaveBeenCalledOnce(),
    );
    gate.resolve(markdown("aaa", "obsolete"));
    await until(async () =>
      expect(await f.read()).toMatchObject({ profiles: [{ systemPrompt: "replacement" }] }),
    );
    expect(
      vi
        .mocked(shared.parseAgentProfileFromMarkdown)
        .mock.calls.some(([input]) => input.content.includes("obsolete")),
    ).toBe(false);
  });

  it("rebinds before publishing child unlinks when the directory unlink notification is late", async () => {
    const f = await fixture();
    const path = join(f.userRoot, "a.md");
    await writeFile(path, markdown("aaa"));
    await f.cache.prepare(f.workspace);
    const obsolete = initialWatcherFor(f.userRoot);
    await rm(f.userRoot, { recursive: true });
    // 原生库可先发文件 unlink；目录检查完成前就重建，会让它不再发 unlinkDir。
    obsolete.emit("all", "unlink", path);
    await until(async () => expect(await f.read()).toMatchObject({ profiles: [] }));
    expect((obsolete as unknown as { close: unknown }).close).toHaveBeenCalledOnce();
    await mkdir(f.userRoot);
    await writeFile(path, markdown("aaa", "recreated"));
    f.emit(f.userRoot, "addDir");
    await until(async () =>
      expect(await f.read()).toMatchObject({ profiles: [{ systemPrompt: "recreated" }] }),
    );
  });

  it("parses changed files once, never rereads other scopes, and returns independent memory copies", async () => {
    const f = await fixture();
    const a = join(f.userRoot, "a.md"),
      b = join(f.userRoot, "b.markdown");
    await writeFile(a, markdown("aaa"));
    await writeFile(b, markdown("bbb"));
    await f.cache.prepare(f.workspace);
    const readFile = vi.spyOn(fs, "readFile"),
      readdir = vi.spyOn(fs, "readdir"),
      parse = vi.spyOn(shared, "parseAgentProfileFromMarkdown");
    readFile.mockClear();
    readdir.mockClear();
    parse.mockClear();
    const before = await f.read();
    await writeFile(a, markdown("aaa", "new"));
    f.emit(a);
    f.emit(a);
    await until(async () =>
      expect(await f.read()).toMatchObject({
        kind: "ready",
        profiles: [{ systemPrompt: "new" }, { name: "bbb" }],
      }),
    );
    expect(readFile.mock.calls.map(([path]) => path)).toEqual([a]);
    expect(readdir).not.toHaveBeenCalled();
    expect(parse).toHaveBeenCalledTimes(1);
    f.state.disabledAgentIds = ["user:user:aaa"];
    f.emit(f.statePath, "change", join(f.root, "state"));
    await until(async () => expect(await f.read()).toMatchObject({ profiles: [{ name: "bbb" }] }));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    await Promise.all(Array.from({ length: 10 }, f.read));
    expect(f.readState).toHaveBeenCalledTimes(2);
    expect(f.readState).toHaveBeenLastCalledWith(f.statePath);
    expect(before).toMatchObject({ profiles: [{ systemPrompt: "aaa" }, { name: "bbb" }] });
    const changed = await f.read();
    if (changed.kind === "ready") changed.profiles.length = 0;
    expect(await f.read()).toMatchObject({ profiles: [{ name: "bbb" }] });
    f.emit(join(f.userRoot, "ignored.txt"));
    f.emit(join(f.userRoot, "nested", "deep.md"));
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("does not postpone a pending file batch when an unrelated parent event arrives", async () => {
    const f = await fixture();
    const path = join(f.userRoot, "a.md");
    await writeFile(path, markdown("aaa", "old"));
    await f.cache.prepare(f.workspace);
    const stats = await fs.stat(f.userRoot);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.stat).mockImplementation((path, options) =>
      path === f.userRoot
        ? (Promise.resolve(stats) as ReturnType<typeof fs.stat>)
        : actual.stat(path, options),
    );
    await writeFile(path, markdown("aaa", "new"));
    vi.mocked(fs.readFile).mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      f.emit(path);
      await vi.advanceTimersByTimeAsync(200);
      for (const events of parentEvents.get(dirname(f.userRoot)) ?? [])
        events.emit("change", { eventType: "rename", filename: "unrelated" });
      await vi.advanceTimersByTimeAsync(100);
      // 父目录检查不应重新开始文件批次的 300ms 合并窗口。
      expect(fs.readFile).toHaveBeenCalledWith(path, "utf8");
      await until(async () =>
        expect(await f.read()).toMatchObject({ profiles: [{ systemPrompt: "new" }] }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["resolve", "reject"])(
    "keeps old snapshots during load and ignores stale %s without losing another changed file",
    async (completion) => {
      const f = await fixture();
      const a = join(f.userRoot, "a.md"),
        b = join(f.userRoot, "b.md");
      await writeFile(a, markdown("aaa"));
      await writeFile(b, markdown("bbb"));
      await f.cache.prepare(f.workspace);
      const before = await f.read();
      const gate = Promise.withResolvers<string>();
      const original = (
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      ).readFile;
      let first = true;
      vi.spyOn(fs, "readFile").mockImplementation(((path: unknown, ...args: unknown[]) => {
        if (path === a && first) {
          first = false;
          return gate.promise;
        }
        return Reflect.apply(original, fs, [path, ...args]);
      }) as typeof fs.readFile);
      f.emit(a);
      await until(() => expect(first).toBe(false));
      expect(await Promise.all([f.read(), f.read()])).toEqual([before, before]);
      await writeFile(a, markdown("aaa", "latest-a"));
      await writeFile(b, markdown("bbb", "latest-b"));
      f.emit(a);
      f.emit(b);
      if (completion === "resolve") gate.resolve(markdown("aaa", "stale"));
      else gate.reject(new Error("stale"));
      await until(async () =>
        expect(await f.read()).toMatchObject({
          kind: "ready",
          profiles: [{ systemPrompt: "latest-a" }, { systemPrompt: "latest-b" }],
        }),
      );
    },
  );

  it("publishes fallback to concurrent readers without retrying on read, then recovers on a file event", async () => {
    const f = await fixture();
    await writeFile(join(f.userRoot, "a.md"), markdown("aaa"));
    await f.cache.prepare(f.workspace);
    f.readState.mockRejectedValue(new Error("state unavailable"));
    f.emit(f.statePath, "change", join(f.root, "state"));
    await until(async () => expect(await f.read()).toEqual({ kind: "built-in-fallback" }));
    const calls = f.readState.mock.calls.length;
    expect(await Promise.all([f.read(), f.read()])).toEqual([
      { kind: "built-in-fallback" },
      { kind: "built-in-fallback" },
    ]);
    expect(f.readState).toHaveBeenCalledTimes(calls);
    const retry = Promise.withResolvers<typeof f.state>();
    f.readState.mockReturnValueOnce(retry.promise);
    try {
      f.emit(f.statePath, "change", join(f.root, "state"));
      await until(() => expect(f.readState).toHaveBeenCalledTimes(calls + 1));
      // 真正读取失败后，重载完成前仍不可用，不能因允许临时回退恢复而重新启用旧值。
      expect(await Promise.all([f.read(), f.read()])).toEqual([
        { kind: "built-in-fallback" },
        { kind: "built-in-fallback" },
      ]);
    } finally {
      retry.resolve(f.state);
    }
    await until(async () =>
      expect(await f.read()).toMatchObject({ kind: "ready", profiles: [{ name: "aaa" }] }),
    );
  });

  it("waits for initialization, absorbs initial changes, and prevents late publication after disposal", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<typeof f.state>();
    f.readState.mockReturnValueOnce(gate.promise);
    const preparing = f.cache.prepare(f.workspace);
    await until(() => expect(f.readState).toHaveBeenCalledTimes(1));
    let done = false;
    const reading = f.read().then((v) => {
      done = true;
      return v;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    const a = join(f.userRoot, "a.md");
    await writeFile(a, markdown("aaa"));
    f.emit(a, "add");
    gate.resolve(f.state);
    await preparing;
    expect(await reading).toMatchObject({ profiles: [{ name: "aaa" }] });
    const late = Promise.withResolvers<typeof f.state>();
    f.readState.mockReturnValueOnce(late.promise);
    f.emit(f.statePath, "change", join(f.root, "state"));
    await until(() => expect(f.readState).toHaveBeenCalledTimes(2));
    f.cache.dispose();
    late.resolve(f.state);
    await expect(f.read()).rejects.toThrow(/disposed/i);
    for (const watcher of watched.values())
      expect((watcher as unknown as { close: unknown }).close).toHaveBeenCalled();
  });

  it.each(["ready", "timeout"])(
    "reuses completed shared data with %s project initialization",
    async (mode) => {
      const f = await fixture();
      const path = join(f.userRoot, "a.md");
      await writeFile(path, markdown("aaa", "old"));
      await f.cache.prepare(f.workspace);
      const before = await f.read();
      const gate = Promise.withResolvers<string>();
      const others = ["b", "c"].map((name) => ({ workspacePath: join(f.root, name) }));
      const projectPath = join(others[0]!.workspacePath, ".zcode", "agents", "b.md");
      await mkdir(dirname(projectPath), { recursive: true });
      await writeFile(projectPath, markdown("bbb", "project"));
      const project = Promise.withResolvers<string>();
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fs.readFile).mockImplementation(((readPath, ...args) => {
        if (readPath === path) return gate.promise;
        if (readPath === projectPath) return project.promise;
        return Reflect.apply(actual.readFile, fs, [readPath, ...args]);
      }) as typeof fs.readFile);
      f.emit(path);
      await until(() =>
        expect(vi.mocked(fs.readFile).mock.results.some((r) => r.value === gate.promise)).toBe(
          true,
        ),
      );
      if (mode === "ready") project.resolve(markdown("bbb", "project"));
      const completed: string[] = [];
      // 与 service 写队列一样顺序准备，不能为同一共享后台刷新反复等待。
      const preparing = (async () => {
        for (const workspace of others) {
          await f.cache.prepare(workspace);
          completed.push(workspace.workspacePath);
        }
      })();
      try {
        if (mode === "timeout") {
          await vi.waitFor(() => expect(completed).toContain(others[0]!.workspacePath), {
            timeout: 6500,
          });
          expect(await f.cache.read(others[0]!)).toEqual({ kind: "built-in-fallback" });
          project.resolve(markdown("bbb", "project"));
        }
        await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 4000 });
        expect(await f.read()).toEqual(before);
        expect(await f.cache.read(others[1]!)).toEqual(before);
        // B 超时过也应和 C 一样复用共享完整结果，不能等共享后台刷新结束才恢复。
        await until(async () =>
          expect(await f.cache.read(others[0]!)).toMatchObject({
            kind: "ready",
            profiles: [{ systemPrompt: "old" }, { systemPrompt: "project" }],
          }),
        );
        expect(f.readState).toHaveBeenCalledOnce();
        expect(vi.mocked(fs.readFile).mock.calls.filter(([p]) => p === path)).toHaveLength(2);
      } finally {
        project.resolve(markdown("bbb", "project"));
        gate.resolve(markdown("aaa", "new"));
        await preparing;
      }
      await until(async () => {
        for (const workspace of [f.workspace, others[1]!])
          expect(await f.cache.read(workspace)).toMatchObject({
            profiles: [{ systemPrompt: "new" }],
          });
        expect(await f.cache.read(others[0]!)).toMatchObject({
          profiles: [{ systemPrompt: "new" }, { systemPrompt: "project" }],
        });
      });
      expect(before).toMatchObject({ profiles: [{ systemPrompt: "old" }] });
    },
  );

  it.each(["initial", "reload"])(
    "bounds %s waiting and publishes late completion without another file event",
    async (mode) => {
      const f = await fixture();
      const path = join(f.userRoot, "a.md");
      await writeFile(path, markdown("aaa", "old"));
      let before: Awaited<ReturnType<typeof f.read>> = { kind: "built-in-fallback" };
      if (mode === "reload") {
        await f.cache.prepare(f.workspace);
        before = await f.read();
      }
      await writeFile(path, markdown("aaa", "new"));
      const gate = Promise.withResolvers<typeof f.state>();
      f.readState.mockClear().mockReturnValueOnce(gate.promise);
      const started = performance.now();
      let prepared = false;
      const preparing = f.cache.prepare(f.workspace).then(() => {
        prepared = true;
      });
      let reading: Promise<unknown> | undefined;
      try {
        await until(() => expect(f.readState).toHaveBeenCalledOnce());
        let readDone = false;
        reading = f.read().then((snapshot) => {
          readDone = true;
          return snapshot;
        });
        expect(prepared).toBe(false);
        await vi.waitFor(() => expect(prepared && readDone).toBe(true), { timeout: 6500 });
        expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
        expect(await reading).toEqual(before);
        const fileReads = vi.mocked(fs.readFile).mock.calls.length;
        expect(await Promise.all([f.read(), f.read()])).toEqual([before, before]);
        expect(fs.readFile).toHaveBeenCalledTimes(fileReads);
        expect(f.readState).toHaveBeenCalledOnce();
      } finally {
        gate.resolve(f.state);
        await preparing;
        await reading;
      }
      await until(async () =>
        expect(await f.read()).toMatchObject({
          kind: "ready",
          profiles: [{ systemPrompt: "new" }],
        }),
      );
      expect(f.readState).toHaveBeenCalledOnce();
      if (mode === "reload") expect(before).toMatchObject({ profiles: [{ systemPrompt: "old" }] });
    },
  );

  it.each(["dispose", "replace"])("ignores a timed-out initial load after %s", async (action) => {
    const f = await fixture();
    const path = join(f.userRoot, "a.md");
    await writeFile(path, markdown("aaa"));
    const gate = Promise.withResolvers<typeof f.state>();
    f.readState.mockReturnValueOnce(gate.promise);
    let prepared = false;
    const preparing = f.cache.prepare(f.workspace).then(() => {
      prepared = true;
    });
    try {
      await vi.waitFor(() => expect(prepared).toBe(true), { timeout: 6500 });
      expect(await f.read()).toEqual({ kind: "built-in-fallback" });
      if (action === "dispose") f.cache.dispose();
      else {
        await writeFile(path, markdown("aaa", "replacement"));
        await f.cache.prepare(f.workspace);
        expect(await f.read()).toMatchObject({ profiles: [{ systemPrompt: "replacement" }] });
      }
    } finally {
      // 已替换的读取不能用旧禁用状态覆盖新范围；销毁后不能重新发布。
      gate.resolve({ ...f.state, disabledAgentIds: ["user:user:aaa"] });
      await preparing;
      // preparing 已提前返回；让迟到读取的微任务链完成后再检查隔离结果。
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (action === "dispose") await expect(f.read()).rejects.toThrow(/disposed/i);
    else expect(await f.read()).toMatchObject({ profiles: [{ systemPrompt: "replacement" }] });
  });

  it("isolates project failure and workspace identities, ignores nested profiles and preserves duplicate precedence", async () => {
    const f = await fixture();
    const project = join(f.workspace.workspacePath, ".zcode", "agents");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "a.md"), markdown("same", "project"));
    const nestedDirectories = [join(project, "deep"), join(f.userRoot, "deep")];
    for (const directory of nestedDirectories) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "ignored.markdown"), markdown("nested"));
    }
    await writeFile(join(f.userRoot, "a.md"), markdown("same", "user"));
    await f.cache.prepare(f.workspace);
    const other = { workspacePath: join(f.root, "other"), workspaceIdentity: "remote:other" };
    await f.cache.prepare(other);
    const own = await f.read();
    expect(own).toMatchObject({
      profiles: [{ systemPrompt: "user" }, { systemPrompt: "project" }],
    });
    expect(await f.cache.read(other)).toMatchObject({ profiles: [{ systemPrompt: "user" }] });
    await f.cache.prepare(f.workspace);
    expect(await f.read()).toEqual(own);
    for (const directory of nestedDirectories) {
      expect(vi.mocked(fs.readdir).mock.calls.map(([path]) => path)).not.toContain(directory);
      expect(vi.mocked(fs.readFile).mock.calls.map(([path]) => path)).not.toContain(
        join(directory, "ignored.markdown"),
      );
    }
    const fail = vi.spyOn(fs, "readFile");
    fail.mockRejectedValueOnce(new Error("project unreadable"));
    f.emit(join(project, "bad.md"), "add", project);
    await until(async () => expect(await f.read()).toEqual({ kind: "built-in-fallback" }));
    expect(await f.cache.read(other)).toMatchObject({ profiles: [{ systemPrompt: "user" }] });
    fail.mockRestore();
    f.emit(join(project, "bad.md"), "unlink", project);
    await until(async () => expect(await f.read()).toEqual(own));
  });
  it("disposes before watcher readiness without hanging preparation", async () => {
    readiness.automatic = false;
    const f = await fixture();
    const preparing = f.cache.prepare(f.workspace);
    const rejected = expect(preparing).rejects.toThrow(/disposed/i);
    await until(() => expect(watched.size).toBe(3));
    f.cache.dispose();
    await rejected;
  });

  it("recovers initial failure on explicit reload and keeps same-path workspace identities separate", async () => {
    const f = await fixture();
    f.readState.mockRejectedValueOnce(new Error("initial unavailable"));
    await f.cache.prepare(f.workspace);
    expect(await f.read()).toEqual({ kind: "built-in-fallback" });
    await f.cache.prepare(f.workspace);
    const a = { ...f.workspace, workspaceIdentity: " test:a " };
    const b = { ...f.workspace, workspaceIdentity: "test:b" };
    await f.cache.prepare(a);
    await f.cache.prepare(b);
    expect(await f.cache.read({ ...a, workspaceIdentity: "test:a" })).toMatchObject({
      kind: "ready",
    });
    expect(await f.cache.read(b)).toMatchObject({ kind: "ready" });
    await expect(f.cache.read({ ...a, workspaceIdentity: "test:unknown" })).rejects.toThrow(
      /not prepared/,
    );
  });
  it("keeps the published snapshot after a watcher error until explicit reload rebuilds observation", async () => {
    const f = await fixture();
    const path = join(f.userRoot, "a.md");
    await writeFile(path, markdown("aaa", "old"));
    await f.cache.prepare(f.workspace);
    const before = await f.read();
    const watchers = [...watched];
    const subscriptions = vi.mocked(fs.watch).mock.calls.map(([, options]) => options?.signal);
    for (const watcher of watchers) watcher.emit("error", new Error("native watcher unavailable"));
    for (const events of parentEvents.values())
      for (const emitter of events) emitter.emit("error", new Error("parent watcher unavailable"));
    await writeFile(path, markdown("aaa", "updated"));
    expect(await f.read()).toEqual(before);
    expect([...watched]).toEqual(watchers);
    await f.cache.prepare(f.workspace);
    expect(await f.read()).toMatchObject({ profiles: [{ systemPrompt: "updated" }] });
    for (const watcher of watchers)
      expect((watcher as unknown as { close: unknown }).close).toHaveBeenCalled();
    for (const signal of subscriptions) expect(signal?.aborted).toBe(true);
    f.cache.dispose();
    for (const [, options] of vi.mocked(fs.watch).mock.calls)
      expect(options?.signal?.aborted).toBe(true);
  });
});
