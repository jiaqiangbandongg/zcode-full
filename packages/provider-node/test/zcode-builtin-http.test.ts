import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { downloadZCodeBuiltinRelease } from "../src/zcode-builtin-download.js";

it("真实 HTTP 响应头已返回但正文不结束时，20 秒总预算关闭连接且下一次可重试", async () => {
  let closed = false;
  let finish = false;
  const release = {
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    if (req.url?.startsWith("/api/v1/client/configs")) {
      res.end(
        JSON.stringify({
          code: 0,
          data: { configs: { builtin_provider_config_json: "https://cdn.example/test.json" } },
        }),
      );
      return;
    }
    if (finish) {
      res.end(JSON.stringify(release));
      return;
    }
    res.writeHead(200);
    res.write("{");
    res.on("close", () => {
      closed = true;
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 只替换测试传输目的地，不放宽生产 CDN 的 HTTPS 校验；本例验证真实 socket/body 取消。
  const options = {
    endpointOrigin: origin,
    appVersion: "test",
    platform: "test",
    request: (url: string | URL, init: RequestInit) =>
      fetch(String(url).startsWith("https://cdn.example") ? `${origin}/cdn` : url, init),
  };
  try {
    const start = Date.now();
    await expect(downloadZCodeBuiltinRelease(options)).rejects.toThrow("cdn: timeout");
    expect(Date.now() - start).toBeLessThan(23_000);
    await vi.waitFor(() => expect(closed).toBe(true));
    finish = true;
    await expect(downloadZCodeBuiltinRelease(options)).resolves.toMatchObject({ revision: 1 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 28_000);
