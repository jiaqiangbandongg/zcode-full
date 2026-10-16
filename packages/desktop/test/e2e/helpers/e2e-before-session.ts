export interface E2EBeforeSessionSetupOptions {
  cid: string;
  specs: string[];
  configureAgentServerEnv: () => void;
  configureCodingPlanTeamMockForSpecs: (specs: string[]) => Promise<void>;
  recordBeforeSession: (cid: string, specs: string[]) => void;
  resetHome: (specs: string[]) => Promise<void>;
  startCodingPlanTeamMockIfNeeded: (specs: string[]) => Promise<void>;
  startCodingPlanUpgradeMockIfNeeded: (specs: string[]) => Promise<void>;
  startUpstreamHttpIfNeeded: (specs: string[]) => Promise<void>;
  startPluginCdnZipFixtureIfNeeded: (specs: string[]) => Promise<void>;
  startOffPeakMockIfNeeded: (specs: string[]) => Promise<void>;
}

export async function runE2EBeforeSessionSetup(options: E2EBeforeSessionSetupOptions) {
  options.recordBeforeSession(options.cid, options.specs);
  // 修复原因：并行 worker 的日志目录在 recordBeforeSession 内按 cid 设置；随后再配置
  // agent server，子进程才能继承 worker 专属的 ZCODE_LOG_DIR，而不会写到共享日志文件。
  options.configureAgentServerEnv();
  await options.startCodingPlanTeamMockIfNeeded(options.specs);
  // Bug 根因：Coding Plan mock 由 launcher 进程在整个 WDIO run 内共享；只在创建
  // server 时读取 configured specs，会让 AUTH-04 的 OAuth/catalog 模式污染后续 spec。
  // 每个 worker session 启动 Electron 前按自己的 spec 重置模式，保持 case 隔离。
  await options.configureCodingPlanTeamMockForSpecs(options.specs);
  await options.startUpstreamHttpIfNeeded(options.specs);
  await options.startCodingPlanUpgradeMockIfNeeded(options.specs);
  await options.startPluginCdnZipFixtureIfNeeded(options.specs);
  await options.startOffPeakMockIfNeeded(options.specs);
  // 修复原因：HOME 删除、重建和 fixture seed 是 Electron session 启动的前置事务；
  // 这里必须等待 reset 完成，否则 Windows 文件锁重试期间会用旧 HOME 启动新 Electron。
  await options.resetHome(options.specs);
}
