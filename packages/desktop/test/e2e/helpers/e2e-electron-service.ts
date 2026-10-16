import ElectronWorkerService, { launcher as ElectronLauncherService } from "wdio-electron-service";

import {
  initializeE2EElectronServiceBridge,
  registerE2EElectronServiceBridgeReload,
} from "./e2e-electron-service-lifecycle.js";

export const launcher: typeof ElectronLauncherService = ElectronLauncherService;

export default class ReloadAwareE2EElectronService extends ElectronWorkerService {
  private capabilities: WebdriverIO.Capabilities | null = null;
  private specs: string[] = [];
  private instance: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser | null = null;

  override async before(
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    instance: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser,
  ) {
    this.capabilities = capabilities;
    this.specs = specs;
    this.instance = instance;
    await this.initializeAndProbe(capabilities, specs, instance);
    if (!instance.isMultiremote) {
      // Bug 根因：reloadSession 不会重新执行 service.before；把当前 service 实例的
      // onReload 注册到 browser，确保 reload helper 能显式重建 CDP bridge 并完成 probe。
      registerE2EElectronServiceBridgeReload(
        instance as WebdriverIO.Browser,
        () => this.onReload(),
      );
    }
  }

  async onReload() {
    if (!this.capabilities || !this.instance) {
      throw new Error("Electron service reload 缺少首次 session 上下文");
    }

    // Bug 根因：WebdriverIO reloadSession 只重建协议 session，不会重新运行 service.before；
    // 旧 CDP bridge 仍绑定已退出的 Electron main process，必须在 onReload 主动重建。
    await super.after();
    await this.initializeAndProbe(this.capabilities, this.specs, this.instance);
  }

  private async initializeAndProbe(
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    instance: WebdriverIO.Browser | WebdriverIO.MultiRemoteBrowser,
  ) {
    await initializeE2EElectronServiceBridge({
      initialize: async () => {
        await super.before(capabilities, specs, instance);
      },
      probe: async () => {
        if (instance.isMultiremote) {
          throw new Error("Desktop E2E readiness probe 不支持 multiremote root browser");
        }
        const result = await (instance as WebdriverIO.Browser).electron.execute((electron) => ({
          appName: electron.app.getName(),
          pid: process.pid,
        }));
        if (!result || typeof result.pid !== "number" || result.pid <= 0) {
          throw new Error(
            `Electron service readiness probe 返回非法结果: ${JSON.stringify(result)}`,
          );
        }
      },
      reset: async () => {
        await super.after();
      },
    });
  }
}
