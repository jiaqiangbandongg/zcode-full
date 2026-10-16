import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ZCODE_VERSION } from "@zcode/shared";
import { clearAppData, seedSettings } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import {
  connectSSHWorkspace,
  readHostProcesses,
  readSSHRuntimeConfig,
} from "../../../helpers/ssh-remote-p0.js";
import {
  startRemoteAssetHttpProxy,
  type RemoteAssetHttpProxy,
} from "../../../helpers/remote-asset-http-proxy.js";

const CASE_MARKER = "E2E_SSH_LOCAL_DOWNLOAD_PROXY";
const FAKE_CDN_HOST = "remote-assets.e2e.invalid";
const DESKTOP_ROOT = resolve(import.meta.dirname, "../../../../..");
const MOCK_CDN_ROOT = join(DESKTOP_ROOT, "mock-cdn");
const PROXY_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "::1",
  ".aminer.cn",
  ".bigmodel.cn",
  ".z.ai",
  ".codegeex.cn",
  ".z.ai",
  ".zcode-ai.com",
  "js.stripe.com",
].join(",");
const REMOTE_ASSET_ENV_KEYS = [
  "ZCODE_DEV_REMOTE_ASSET_USE_CDN",
  "ZCODE_REMOTE_ASSET_CDN_BASE_URL",
  "ZCODE_REMOTE_ASSET_CACHE_DIR",
] as const;

describe(`${CASE_MARKER}: SSH 本地下载遵循应用代理`, () => {
  let proxy: RemoteAssetHttpProxy | null = null;
  let cacheDir: string | null = null;
  const originalEnv = new Map<string, string | undefined>();

  before(() => {
    for (const key of REMOTE_ASSET_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  after(async () => {
    try {
      await browser.electron.restoreAllMocks();
      await clearAppData();
    } finally {
      await proxy?.close();
      proxy = null;
      if (cacheDir) {
        await rm(cacheDir, { recursive: true, force: true });
        cacheDir = null;
      }
      restoreRemoteAssetEnv(originalEnv);
    }
  });

  it("SSH-P0-CONN-04 本地 fresh manifest 只通过显式代理获取", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    proxy = await startRemoteAssetHttpProxy({
      expectedHost: FAKE_CDN_HOST,
      mockCdnRoot: MOCK_CDN_ROOT,
    });
    cacheDir = await mkdtemp(join(tmpdir(), "zcode-e2e-remote-assets-proxy-"));

    process.env.ZCODE_DEV_REMOTE_ASSET_USE_CDN = "1";
    process.env.ZCODE_REMOTE_ASSET_CDN_BASE_URL = `http://${FAKE_CDN_HOST}`;
    process.env.ZCODE_REMOTE_ASSET_CACHE_DIR = cacheDir;
    await seedSettings({
      httpProxy: proxy.proxyUrl,
      httpProxyNoProxy: PROXY_NO_PROXY,
    });

    // 设置页代理按 Window Host 生命周期冻结；冷启动后再执行真实 SSH 向导。
    await browser.reloadSession();
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    const tab = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath,
    });

    expect(tab.remoteSessionId).toBeTruthy();
    expect(tab.secretPersistedInTab).toBe(false);
    expect(
      proxy.requestPaths.some(
        (path) =>
          path.endsWith(`/${ZCODE_VERSION}/manifest-linux-x64.json`) ||
          path.endsWith(`/${ZCODE_VERSION}/manifest-linux-arm64.json`),
      ),
    ).toBe(true);
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});

function restoreRemoteAssetEnv(originalEnv: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
