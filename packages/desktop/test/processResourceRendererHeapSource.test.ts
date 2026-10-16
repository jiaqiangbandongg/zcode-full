import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, type ProcessResourceRole } from "@zcode/shared";

const h = vi.hoisted(() => ({
  ipcListeners: new Map<string, Array<(...args: unknown[]) => unknown>>(),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: {
    getAppMetrics: vi.fn(() => []),
    getPath: vi.fn(() => "/tmp"),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp/zcode-app"),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      const listeners = h.ipcListeners.get(channel) ?? [];
      listeners.push(listener);
      h.ipcListeners.set(channel, listeners);
    }),
    removeAllListeners: vi.fn((channel: string) => h.ipcListeners.delete(channel)),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      h.ipcHandlers.set(channel, handler),
    ),
  },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

vi.mock("../src/main/logger.js", () => ({
  // 只验证 heap 样本的摄入与投递，隔离 resourceManagerWindow 传递进来的日志 IO。
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const MAIN_WINDOW_WC_ID = 11;
const SECOND_MAIN_WINDOW_WC_ID = 12;
const AUX_WINDOW_WC_ID = 21;

interface Collected {
  heapSamples: Array<[ProcessResourceRole, number]>;
  roleSamples: number;
}

async function loadSource() {
  return import("../src/main/processResourceRendererHeapSource.js");
}

async function runSample(): Promise<Collected> {
  const { rendererHeapProcessResourceSampleSource } = await loadSource();
  const collected: Collected = { heapSamples: [], roleSamples: 0 };
  rendererHeapProcessResourceSampleSource.sample?.({
    now: 0,
    addRoleSample: () => {
      collected.roleSamples += 1;
    },
    addRoleHeapSample: (role, heapUsedKb) => collected.heapSamples.push([role, heapUsedKb]),
    addAppProcessTotals: () => {},
  });
  return collected;
}

describe("processResourceRendererHeapSource", () => {
  beforeEach(async () => {
    h.ipcListeners.clear();
    h.ipcHandlers.clear();
    const { registerMainApplicationWindow, unregisterMainApplicationWindow } =
      await import("../src/main/resourceManagerWindow.js");
    for (const id of [MAIN_WINDOW_WC_ID, SECOND_MAIN_WINDOW_WC_ID, AUX_WINDOW_WC_ID]) {
      unregisterMainApplicationWindow(id);
    }
    registerMainApplicationWindow(MAIN_WINDOW_WC_ID);
    const { rendererHeapProcessResourceSampleSource } = await loadSource();
    rendererHeapProcessResourceSampleSource.reset?.();
  });

  it("PRT-021 主窗口 renderer 的样本只贡献 renderer_main 的 heap，不额外开角色样本", async () => {
    const { ingestRendererHeapSample } = await loadSource();
    ingestRendererHeapSample(MAIN_WINDOW_WC_ID, { heapUsedKb: 51_200 });

    const collected = await runSample();

    expect(collected.heapSamples).toEqual([["renderer_main", 51_200]]);
    // renderer 的 CPU 与 RSS 仍来自 main 的 getAppMetrics，heap 样本不重复开角色样本。
    expect(collected.roleSamples).toBe(0);
  });

  it("非主窗口 webContents（辅助窗口 / DevTools / webview guest）的样本被忽略", async () => {
    const { ingestRendererHeapSample } = await loadSource();
    ingestRendererHeapSample(AUX_WINDOW_WC_ID, { heapUsedKb: 999_999 });

    expect((await runSample()).heapSamples).toEqual([]);
  });

  it("多个主窗口时取本 tick 已到达读数的最大值", async () => {
    const { registerMainApplicationWindow } = await import("../src/main/resourceManagerWindow.js");
    registerMainApplicationWindow(SECOND_MAIN_WINDOW_WC_ID);
    const { ingestRendererHeapSample } = await loadSource();
    ingestRendererHeapSample(MAIN_WINDOW_WC_ID, { heapUsedKb: 51_200 });
    ingestRendererHeapSample(SECOND_MAIN_WINDOW_WC_ID, { heapUsedKb: 76_800 });

    expect((await runSample()).heapSamples).toEqual([["renderer_main", 76_800]]);
  });

  it("一次读数只贡献一个 heap 样本，下一个 tick 不拿旧值充当当前事实", async () => {
    const { ingestRendererHeapSample } = await loadSource();
    ingestRendererHeapSample(MAIN_WINDOW_WC_ID, { heapUsedKb: 51_200 });

    expect((await runSample()).heapSamples).toEqual([["renderer_main", 51_200]]);
    expect((await runSample()).heapSamples).toEqual([]);
  });

  it("字段缺失、类型错误或夹带多余字段的样本在 main 入口被丢弃且不抛错", async () => {
    const { ingestRendererHeapSample } = await loadSource();
    for (const invalid of [
      undefined,
      null,
      "sample",
      {},
      { heapUsedKb: "512" },
      { heapUsedKb: Number.NaN },
      { heapUsedKb: -1 },
      // 隐私红线：renderer 不能借这条通道把路径 / session 之类的上下文带进 main。
      { heapUsedKb: 512, workspacePath: "/Users/me/secret" },
    ]) {
      expect(() => ingestRendererHeapSample(MAIN_WINDOW_WC_ID, invalid)).not.toThrow();
    }

    expect((await runSample()).heapSamples).toEqual([]);
  });

  it("reset 丢弃尚未交付的样本", async () => {
    const { ingestRendererHeapSample, rendererHeapProcessResourceSampleSource } =
      await loadSource();
    ingestRendererHeapSample(MAIN_WINDOW_WC_ID, { heapUsedKb: 51_200 });
    rendererHeapProcessResourceSampleSource.reset?.();

    expect((await runSample()).heapSamples).toEqual([]);
  });

  it("已注册进来源注册表", async () => {
    const { PROCESS_RESOURCE_SAMPLE_SOURCES } =
      await import("../src/main/processResourceSampleSourceRegistry.js");
    const { rendererHeapProcessResourceSampleSource } = await loadSource();

    expect(PROCESS_RESOURCE_SAMPLE_SOURCES.map((source) => source.id)).toContain(
      rendererHeapProcessResourceSampleSource.id,
    );
  });

  it("main 侧只监听单向 send，并按发送方 webContents 归属", async () => {
    const { registerRendererHeapSampleIpc } = await loadSource();
    registerRendererHeapSampleIpc();
    // 重复注册不叠加监听器，否则同一条样本会被摄入多次。
    registerRendererHeapSampleIpc();

    expect(h.ipcHandlers.has(PlatformChannels.ReportRendererHeapSample)).toBe(false);
    const listeners = h.ipcListeners.get(PlatformChannels.ReportRendererHeapSample) ?? [];
    expect(listeners).toHaveLength(1);

    const listener = listeners[0];
    listener?.({ sender: { id: AUX_WINDOW_WC_ID } }, { heapUsedKb: 999_999 });
    listener?.({ sender: { id: MAIN_WINDOW_WC_ID } }, { heapUsedKb: 51_200 });

    expect((await runSample()).heapSamples).toEqual([["renderer_main", 51_200]]);
  });

  it("preload 桥只暴露单向 send，不暴露 invoke", async () => {
    const source = await readFile(
      join(import.meta.dirname, "../src/preload/index.ts"),
      "utf8",
    ).then((text) => text.replace(/\s+/g, ""));

    expect(source).toContain("ipcRenderer.send(PlatformChannels.ReportRendererHeapSample");
    expect(source).not.toContain("ipcRenderer.invoke(PlatformChannels.ReportRendererHeapSample");
  });
});
