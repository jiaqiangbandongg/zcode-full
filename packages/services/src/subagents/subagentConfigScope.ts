import { watch, type FSWatcher } from "chokidar";
import { stat, watch as watchDirectory } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("subagentRuntimeConfig");
const EVENT_DEBOUNCE_MS = 300;
const WRITE_STABILITY_MS = 1000;
const WRITE_POLL_MS = 500;
export type SubagentFileChanges = Map<string, "read" | "remove">;
export interface SubagentConfigLoadContext {
  signal: AbortSignal;
  waitForStableFile(path: string): Promise<boolean>;
}

async function waitForStableFile(path: string, signal: AbortSignal): Promise<boolean> {
  let previous: Awaited<ReturnType<typeof stat>> | undefined;
  let stableSince = performance.now();
  while (true) {
    signal.throwIfAborted();
    const current = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!current) return false;
    if (
      !previous ||
      current.size !== previous.size ||
      current.mtimeMs !== previous.mtimeMs ||
      current.ctimeMs !== previous.ctimeMs ||
      current.ino !== previous.ino ||
      current.dev !== previous.dev
    )
      stableSince = performance.now();
    else if (performance.now() - stableSince >= WRITE_STABILITY_MS) return true;
    previous = current;
    await delay(WRITE_POLL_MS, undefined, { signal });
  }
}

/** 一个配置范围串行吸收文件变化，RPC 只消费上层已完成的 snapshot。 */
export function createSubagentConfigScope<T>(options: {
  root: string;
  file?: string;
  load(
    previous: T | undefined,
    changes: SubagentFileChanges | undefined,
    context: SubagentConfigLoadContext,
  ): Promise<T>;
  onSettled(): void;
}) {
  const root = resolve(options.root);
  const file = options.file && resolve(options.file);
  let disposed = false,
    revision = 0,
    failed = false,
    reset = true;
  let value: T | undefined;
  const pending: SubagentFileChanges = new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;
  let initialized = false,
    stabilize = false;
  let watcher: FSWatcher | undefined, anchor: string | undefined;
  let parentWatch: AbortController | undefined;
  let anchorStats: Awaited<ReturnType<typeof stat>> | undefined;
  let releaseReady: (() => void) | undefined;
  let binding: Promise<void> | undefined;
  let checkRequested = false,
    replaceRequested = false;
  let loadController: AbortController | undefined;

  function schedule() {
    if (timer) clearTimeout(timer);
    if (!disposed && initialized && (reset || pending.size))
      timer = setTimeout(() => {
        timer = undefined;
        void drain();
      }, EVENT_DEBOUNCE_MS);
  }
  async function drain() {
    if (disposed || draining) return draining;
    const changedPaths = new Set<string>();
    draining = (async () => {
      while (!disposed) {
        // 子文件 unlink 可能早于 unlinkDir；发布空范围前确认目录，避免立即重建后
        // 原生库不再识别旧目录已删除。每个删除批次仅检查一次，不额外读取 Markdown。
        if ([...pending.values()].includes("remove")) await checkWatch();
        await binding;
        if (disposed || (!reset && !pending.size)) break;
        const generation = revision;
        const full = reset || failed;
        const changes = new Map(pending);
        for (const path of changes.keys()) changedPaths.add(path);
        if (full) changedPaths.add(root);
        pending.clear();
        reset = false;
        const controller = new AbortController();
        loadController = controller;
        const needsStability = full && stabilize;
        try {
          const next = await options.load(value, full ? undefined : changes, {
            signal: controller.signal,
            // 新 watcher 的初次扫描不经过 awaitWriteFinish；仅目录恢复补扫显式等待稳定。
            waitForStableFile: (path) =>
              needsStability ? waitForStableFile(path, controller.signal) : Promise.resolve(true),
          });
          if (disposed) return;
          if (controller.signal.aborted) continue;
          value = next;
          failed = false;
          if (full) stabilize = false;
        } catch (error) {
          if (disposed) return;
          if (controller.signal.aborted) continue;
          if (generation !== revision) {
            for (const [path, action] of changes) if (!pending.has(path)) pending.set(path, action);
            if (full) reset = true;
          } else {
            failed = true;
            logger.warn(undefined, "Subagent 配置读取失败，使用内置定义并等待文件变化", {
              path: root,
              error: String(error),
            });
          }
        } finally {
          // 某个候选读取失败时，同时取消该补扫中其他文件的稳定等待。
          controller.abort();
          if (loadController === controller) loadController = undefined;
        }
      }
    })().finally(() => {
      draining = undefined;
      if (!disposed) {
        options.onSettled();
        if (changedPaths.size)
          logger.info(undefined, "Subagent 配置文件更新完成", {
            path: root,
            changedPaths: [...changedPaths],
            fallback: failed,
          });
      }
    });
    return draining;
  }
  function changed(event: string, path: string) {
    const absolute = resolve(path);
    if (absolute === root && (event === "unlinkDir" || event === "add" || event === "unlink")) {
      void checkWatch(true);
      return;
    }
    if (
      dirname(absolute) !== root ||
      !(file ? absolute === file : /\.(md|markdown)$/iu.test(absolute))
    )
      return;
    if (event === "unlink") pending.set(absolute, "remove");
    else if (event === "add" || event === "change") pending.set(absolute, "read");
    else return;
    revision++;
    schedule();
  }
  async function findAnchor() {
    let path = root;
    while (true) {
      try {
        const stats = await stat(path);
        if (path === root || stats.isDirectory()) return { path, stats };
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      const parent = dirname(path);
      if (parent === path) throw new Error(`Subagent watch root unavailable: ${root}`);
      path = parent;
    }
  }
  function checkWatch(replace = false): Promise<void> {
    checkRequested = true;
    replaceRequested ||= replace;
    if (replace) {
      revision++;
      reset = true;
      loadController?.abort();
      releaseReady?.();
    }
    if (binding) return binding;
    binding = (async () => {
      while (!disposed && checkRequested) {
        checkRequested = false;
        const force = replaceRequested;
        replaceRequested = false;
        const { path: nextAnchor, stats } = await findAnchor();
        if (disposed) return;
        if (
          watcher &&
          anchor === nextAnchor &&
          !force &&
          anchorStats?.dev === stats.dev &&
          anchorStats.ino === stats.ino
        )
          continue;
        const previous = watcher;
        watcher = undefined;
        parentWatch?.abort();
        if (previous) await previous.close();
        if (disposed) return;
        if (anchor !== undefined && (anchor === root || nextAnchor === root)) {
          revision++;
          reset = true;
          stabilize = nextAnchor === root;
          loadController?.abort();
        }
        anchor = nextAnchor;
        anchorStats = stats;
        const direct = anchor === root;
        const parent = dirname(anchor);
        // 祖先枚举会返回磁盘真实大小写，字符串筛选会误丢 AGENTS。直接以配置路径监听，
        // 缺失时的浅层父监听只负责发现目录，不比较目标分支名称，也不扫描其内容。
        const current = watch(anchor, {
          persistent: true,
          ignoreInitial: true,
          depth: 0,
          usePolling: false,
          followSymlinks: true,
          atomic: true,
          awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: WRITE_POLL_MS },
          ignored: (path, info) => {
            const absolute = resolve(path);
            if (absolute === nextAnchor) return false;
            if (dirname(absolute) !== nextAnchor) return true;
            if (!direct) return info ? !info.isDirectory() && !info.isSymbolicLink() : false;
            return file
              ? absolute !== file
              : Boolean(info?.isDirectory()) || !/\.(md|markdown)$/iu.test(absolute);
          },
        });
        watcher = current;
        current.on("raw", () => {
          if (!direct && !disposed && watcher === current) void checkWatch();
        });
        // Windows 不报告空目录自身的移动；父目录只订阅原生结构事件，不枚举其内容。
        // 与 Chokidar 的文件索引分离，避免 AGENTS 被误当作逻辑 agents 的删除事件。
        if (parent !== anchor) {
          const controller = new AbortController();
          parentWatch = controller;
          void (async () => {
            for await (const _event of watchDirectory(parent, { signal: controller.signal })) {
              if (disposed || watcher !== current) return;
              await checkWatch();
            }
          })().catch((error) => {
            if (!controller.signal.aborted && !disposed)
              logger.warn(undefined, "Subagent 父目录监听异常，显式重载可重建监听", {
                path: parent,
                error: String(error),
              });
          });
        }
        current.on("all", (event, path) => {
          if (disposed || watcher !== current) return;
          if (direct) changed(event, path);
          else if (event === "addDir" || event === "unlinkDir") void checkWatch();
        });
        await new Promise<void>((ready) => {
          releaseReady = ready;
          current.once("ready", ready);
          current.on("error", (error) => {
            if (disposed || watcher !== current) return;
            logger.warn(undefined, "Subagent 文件监听异常，显式重载可重建监听", {
              path: root,
              error: String(error),
            });
            ready();
          });
        });
        releaseReady = undefined;
        // 补上检查目录与监听就绪之间的空窗，不依赖轮询或延时猜测。
        checkRequested = true;
      }
    })()
      .catch((error) => {
        if (!disposed)
          logger.warn(undefined, "Subagent 文件监听初始化失败，显式重载可重建监听", {
            path: root,
            error: String(error),
          });
      })
      .finally(() => {
        binding = undefined;
        // 无关父目录事件只检查位置，不能反复推迟已经排队的配置更新。
        if (!timer) schedule();
        if (!disposed) options.onSettled();
      });
    return binding;
  }
  const ready = checkWatch().then(async () => {
    if (disposed) return;
    await drain();
    initialized = true;
  });
  return {
    ready,
    async settle() {
      await ready;
      await binding;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await drain();
    },
    get value() {
      return value;
    },
    get failed() {
      return failed;
    },
    get busy() {
      return (
        !disposed &&
        (!initialized || Boolean(binding) || Boolean(draining) || reset || pending.size > 0)
      );
    },
    dispose() {
      disposed = true;
      loadController?.abort();
      parentWatch?.abort();
      releaseReady?.();
      if (timer) clearTimeout(timer);
      pending.clear();
      const current = watcher;
      watcher = undefined;
      void current?.close().catch((error) =>
        logger.warn(undefined, "Subagent 文件监听关闭失败", {
          path: root,
          error: String(error),
        }),
      );
    },
  };
}
