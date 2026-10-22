import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { readHostProcesses } from "./e2e/helpers/ssh-remote-p0.js";
vi.mock("./e2e/helpers/desktop-app.js", () => ({}));
vi.mock("./e2e/helpers/custom-openai-provider-store.js", () => ({}));
vi.mock("./e2e/helpers/v4-conversation.js", () => ({}));
afterEach(() => vi.unstubAllGlobals());

it("Host 探针只读 Main 指标，不打开资源管理器或切换业务窗口", async () => {
  const electron = {
    app: {
      getAppMetrics: () => [
        { pid: 11, type: "Browser" },
        {
          pid: 22,
          type: "Utility",
          name: "zcode-host-local-1",
          serviceName: "node.mojom.NodeService",
        },
        { pid: 33, type: "Utility", name: "zcode-cron-scheduler" },
      ],
    },
  };
  vi.stubGlobal("browser", {
    electron: {
      execute: async (fn: (arg: unknown) => unknown) =>
        runInNewContext(`(${fn.toString()})(electron)`, { electron }),
    },
    waitUntil: async (fn: () => Promise<boolean>) => {
      expect(await fn()).toBe(true);
    },
  });
  expect(await readHostProcesses()).toEqual([{ pid: 22, name: "zcode-host-local-1" }]);
});
