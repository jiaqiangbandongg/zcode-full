/** Vitest 用：替代 @arms/rum-electron，避免加载真实 electron（CJS 命名导出在 ESM 下失败） */
function noop(): void {}

const armsRumElectronStub = {
  init: async () => {},
  sendCustom: noop,
  sendEvent: noop,
  setConfig: noop,
  getConfig: () => ({}),
  instrumentTRPC: <T>(t: T) => t,
};

export default armsRumElectronStub;
