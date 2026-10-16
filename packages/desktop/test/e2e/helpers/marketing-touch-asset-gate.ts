/** 仅控制隔离资源 HTTP 的时机；reset/stop 必须释放旧响应，避免污染后续用例。 */
export function createMarketingAssetGate() {
  let held = false;
  const waiting: Array<() => void> = [];
  const reset = () => {
    held = false;
    waiting.splice(0).forEach((resolve) => resolve());
  };
  return {
    reset,
    async wait() {
      if (held) await new Promise<void>((resolve) => waiting.push(resolve));
    },
    control(path: string) {
      if (path === "/__e2e/marketing/asset-state") return { pending: waiting.length };
      if (path === "/__e2e/marketing/asset-hold") held = true;
      else if (path === "/__e2e/marketing/asset-release") reset();
      else return null;
      return { ok: true };
    },
  };
}
