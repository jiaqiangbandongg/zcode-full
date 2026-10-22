import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  workspace: vi.fn(async (_path: string, _timeout: number) => {}),
  defaultWorkspace: vi.fn(async () => {
    throw new Error("default workspace is not opened");
  }),
  reload: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
}));
vi.mock("./e2e/helpers/desktop-app.js", () => ({
  getE2EAppDataPaths: () => ({ configFile: "/unused/provider.json" }),
  waitForWorkspaceApp: mocks.workspace,
  waitForDefaultWorkspaceReady: mocks.defaultWorkspace,
}));
vi.mock("./e2e/helpers/e2e-electron-reload.js", () => ({
  reloadElectronSessionSafely: mocks.reload,
}));
vi.mock("./e2e/helpers/e2e-electron-storage.js", () => ({ flushElectronStorageData: mocks.flush }));
vi.mock("./e2e/helpers/occupation-onboarding.js", () => ({
  skipOccupationOnboardingIfPresent: vi.fn(async () => {}),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each([
  "restartIntoWorkspacePreservingProfile",
  "restartIntoWorkspaceRestoringPreferences",
] as const)("%s 只等待请求的活动目录，不要求无关默认目录被重建", async (method) => {
  vi.stubGlobal("browser", {
    electron: { execute: vi.fn(async () => "/profile") },
    execute: vi.fn(async () => ({})),
    requestedCapabilities: { "goog:chromeOptions": { args: [] } },
  });
  const helpers = await import("./e2e/helpers/model-provider-restart-runtime.js");
  const afterExit = vi.fn();
  await helpers[method]("/active-project", { afterElectronProcessExit: afterExit });
  expect(mocks.defaultWorkspace).not.toHaveBeenCalled();
  expect(mocks.workspace.mock.calls.every((call) => call[0] === "/active-project")).toBe(true);
  expect(mocks.workspace).toHaveBeenCalled();
  expect(mocks.reload).toHaveBeenCalledWith(expect.anything(), {
    afterElectronProcessExit: afterExit,
  });
  expect(mocks.reload.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.workspace.mock.invocationCallOrder[0]!,
  );
});
