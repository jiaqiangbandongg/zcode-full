import { AccountProviderService, ProviderConfigMap } from "@zcode/provider";
import { NodeProviderRegistryRuntime } from "../../src/provider-registry-runtime.js";

// 真实子进程只消费共享文件，模拟不拥有下载器的 Worker；Account 使用本地可控事实。
let account!: AccountProviderService;
const runtime = new NodeProviderRegistryRuntime({
  zcodeBuiltinFilePath: process.argv[2]!,
  personalFilePath: process.argv[3]!,
  personalPollingIntervalMs: false,
  createAccountSource(configSource) {
    account = new AccountProviderService({
      configSource,
      resolve: async () => ({ providers: ProviderConfigMap.empty(), states: {} }),
    });
    return account;
  },
});
function report() {
  const snapshot = runtime.registryService.getSnapshot()!;
  process.send?.({
    pid: process.pid,
    builtin: snapshot.config.zcodeBuiltinRevision,
    account: snapshot.account.basedOnZCodeBuiltinRevision,
  });
}
runtime.registryService.onDidChange(report);
await runtime.start();
report();
process.on("message", () => {
  runtime.dispose();
  account.dispose();
  process.disconnect();
});
process.on("disconnect", () => {
  runtime.dispose();
  account.dispose();
});
