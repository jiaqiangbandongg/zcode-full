const PROVIDER_CONFIG_POLLING_SETTLE_MS = 2_000;

/**
 * Personal Provider Config 由已运行的 Agent 按轮询周期读取。
 * E2E 在最终保存后统一留出两秒，避免继续依赖已经删除的 Registry push 日志。
 */
export async function waitForProviderConfigPolling(): Promise<void> {
  await browser.pause(PROVIDER_CONFIG_POLLING_SETTLE_MS);
}
