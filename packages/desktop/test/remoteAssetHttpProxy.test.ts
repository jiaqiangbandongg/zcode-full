import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAgent, fetch } from "undici";
import { expect, it } from "vitest";
import { startRemoteAssetHttpProxy } from "./e2e/helpers/remote-asset-http-proxy.js";

it("serves the fake CDN through the CONNECT tunnel used by Host ProxyAgent", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-proxy-connect-"));
  await mkdir(join(root, "releases", "test"), { recursive: true });
  await writeFile(join(root, "releases", "test", "source-server-release.json"), "fixture");
  const proxy = await startRemoteAssetHttpProxy({
    expectedHost: "cdn.e2e.invalid",
    mockCdnRoot: root,
  });
  const dispatcher = new ProxyAgent(proxy.proxyUrl);
  try {
    const response = await fetch("http://cdn.e2e.invalid/test/source-server-release.json", {
      dispatcher,
      signal: AbortSignal.timeout(1_000),
    });
    expect(await response.text()).toBe("fixture");
    expect(proxy.requestPaths).toEqual(["/test/source-server-release.json"]);
  } finally {
    await dispatcher.destroy();
    await proxy.close();
    await rm(root, { recursive: true, force: true });
  }
});
