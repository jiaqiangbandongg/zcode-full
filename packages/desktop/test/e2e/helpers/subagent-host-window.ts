import { readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface HostFaultControl {
  tracePaths?: string[];
  files?: Array<{
    id: string;
    path: string;
    operation: "readFile" | "readdir" | "writeFile";
    action: "hold" | "fail";
    once?: boolean;
    rejectAfterRelease?: boolean;
  }>;
  released?: string[];
}
export async function setHostFaults(control: HostFaultControl) {
  const path = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "host-fault-control.json");
  await writeFile(path + ".tmp", JSON.stringify(control));
  await rename(path + ".tmp", path);
}
export async function readHostBoundary() {
  const root = process.env.ZCODE_E2E_ARTIFACT_DIR!;
  return (
    await Promise.all(
      (
        await readdir(root)
      )
        .filter((p) => /^host-boundary-\d+\.jsonl$/u.test(p))
        .map(async (p) =>
          (await readFile(join(root, p), "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  pid: number;
                  kind: string;
                  id?: string;
                  paths?: string[];
                  operation?: string;
                  stack?: string;
                  readCounts?: Record<string, number>;
                },
            ),
        ),
    )
  ).flat();
}
export async function waitForHostBoundary(kind: string, id?: string) {
  await browser.waitUntil(
    async () => (await readHostBoundary()).some((r) => r.kind === kind && (!id || r.id === id)),
    { timeout: 15000, timeoutMsg: `缺少 Host 边界事件 ${kind}/${id ?? ""}` },
  );
}
/** 测试侧控制 Electron 窗口发现并预加载文件/IPC 故障边界，调用产品已有 activate 路径。 */
export async function openSubagentHostWindow() {
  await setHostFaults({});
  const handles = await browser.getWindowHandles();
  const windowId = await browser.electron.execute(
    async (electron, preload, root) => {
      const originalWindows = electron.BrowserWindow.getAllWindows;
      const originalFork = electron.utilityProcess.fork;
      let didFork!: () => void;
      const forked = new Promise<void>((resolve) => {
        didFork = resolve;
      });
      const created = new Promise<number>((resolve) =>
        electron.app.once("browser-window-created", (_event, window) => {
          electron.BrowserWindow.getAllWindows = originalWindows;
          resolve(window.id);
        }),
      );
      electron.utilityProcess.fork = (path, args, options) => {
        electron.utilityProcess.fork = originalFork;
        const child = originalFork(preload, [path, ...(args ?? [])], {
          ...options,
          env: { ...options?.env, ZCODE_E2E_HOST_FAULT_ROOT: root },
        });
        didFork();
        return child;
      };
      electron.BrowserWindow.getAllWindows = () => [];
      try {
        electron.app.emit("activate");
        const [id] = await Promise.all([created, forked]);
        return id;
      } finally {
        electron.BrowserWindow.getAllWindows = originalWindows;
        electron.utilityProcess.fork = originalFork;
      }
    },
    fileURLToPath(new URL("./subagent-host-faults.cjs", import.meta.url)),
    process.env.ZCODE_E2E_ARTIFACT_DIR!,
  );
  let handle = "";
  await browser.waitUntil(
    async () => {
      handle = (await browser.getWindowHandles()).find((h) => !handles.includes(h)) ?? "";
      return Boolean(handle);
    },
    { timeout: 30000 },
  );
  await browser.switchToWindow(handle);
  await waitForHostBoundary("ready");
  return { windowId, handle };
}
