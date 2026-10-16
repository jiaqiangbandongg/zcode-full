/**
 * 主窗口 renderer heap 的样本来源（注册表第四行）。
 *
 * renderer 每 60 秒读一次 `performance.memory`，在写本地诊断日志的同一次读数里经 preload 桥
 * 单向 send 到 main；这里存下最近一次读数，下一个 10 秒 tick 把它并进 `renderer_main`
 * 角色的完整样本，成为 `heap_used_kb_mean` / `heap_used_kb_peak`。
 *
 * 只取 heap：renderer 的 CPU 与 RSS 的唯一来源是 main 的 `getAppMetrics()`，
 * 把 60 秒口径的读数混进 10 秒序列会污染 `sample_count` 与统计量。
 * 每次读数只贡献一个 heap 样本（交付即清空），不拿旧值充当当前事实。
 *
 * 归属只认发送方 webContents：主窗口 webContents 才是 `renderer_main`，
 * 资源管理器 / about / DevTools / `<webview>` guest 的样本一律丢弃（它们归
 * `chromium_other` 与 `renderer_guest`，按角色定义表不带 heap）。
 */

import { ipcMain } from "electron";
import { PlatformChannels, rendererHeapSampleSchema } from "@zcode/shared";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { isMainApplicationWindowWebContents } from "./resourceManagerWindow.js";

/** 发送方 webContents id → 尚未交付的 heap 读数（KB）。 */
const pendingHeapUsedKb = new Map<number, number>();

/**
 * main 侧的信任边界：payload 来自 renderer，按 `strict` schema 校验，
 * 非法消息（字段缺失、类型错误、夹带路径等多余字段）直接丢弃，不抛错。
 */
export function ingestRendererHeapSample(webContentsId: number, raw: unknown): void {
  if (!isMainApplicationWindowWebContents(webContentsId)) {
    return;
  }
  const parsed = rendererHeapSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  pendingHeapUsedKb.set(webContentsId, parsed.data.heapUsedKb);
}

/** preload 桥的 main 侧落点：只监听单向 send，不提供 invoke。 */
export function registerRendererHeapSampleIpc(): void {
  // 这条通道只允许一个监听器：重复注册不叠加，避免同一条样本被摄入多次。
  ipcMain.removeAllListeners(PlatformChannels.ReportRendererHeapSample);
  ipcMain.on(PlatformChannels.ReportRendererHeapSample, (event, payload: unknown) => {
    ingestRendererHeapSample(event.sender.id, payload);
  });
}

export const rendererHeapProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "renderer_heap",
  sample(context) {
    // 先取走再投递：投递抛错也不会把旧读数留到下一个 tick。
    const arrivedHeapUsedKb = [...pendingHeapUsedKb.values()];
    pendingHeapUsedKb.clear();
    if (arrivedHeapUsedKb.length === 0) {
      return;
    }
    /**
     * 多窗口时取本 tick 已到达读数里的最大值。这不是 rss 的「同 tick 全部进程取最大」：
     * 每个窗口的 60 秒定时器各自相位，同一个 10 秒 tick 通常只收到其中一部分窗口的读数，
     * 因此 `heap_used_kb_peak` 是最大单窗口，`heap_used_kb_mean` 是各窗口读数的混合平均。
     * heap 只是 60 秒口径的附加维度，不为它保留旧读数（交付即清空的另一面）。
     */
    context.addRoleHeapSample("renderer_main", Math.max(...arrivedHeapUsedKb));
  },
  reset() {
    pendingHeapUsedKb.clear();
  },
};
