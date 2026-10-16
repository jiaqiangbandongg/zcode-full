import type { IStorageService, StorageUsageSnapshot } from "./contract.js";

/**
 * 契约用法示例：进入分区时订阅进度并开始扫描，离开时取消；清理后重新扫描。
 * 这是 UI hook 的最小骨架，不含任何实现细节。
 */
export async function useStorageSection(
  storage: IStorageService,
  render: (snapshot: StorageUsageSnapshot) => void,
): Promise<{ leave: () => Promise<void>; cleanTrajectories: () => Promise<void> }> {
  let currentJobId: string | null = null;
  const subscription = storage.onScanProgress((snapshot) => {
    // 只消费当前 job 的快照，旧 job 的尾包直接丢弃。
    if (snapshot.jobId === currentJobId) render(snapshot);
  });
  const start = async () => {
    currentJobId = (await storage.startScan()).jobId;
  };
  await start();
  return {
    leave: async () => {
      subscription.dispose();
      if (currentJobId) await storage.cancelScan(currentJobId);
    },
    cleanTrajectories: async () => {
      await storage.clean({ rootId: "home", categoryId: "modelTrajectory" });
      await start();
    },
  };
}
