import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";

export async function prepareAccessToken401Fixture(options: {
  specs: string[];
  credentialsFile: string;
  settingsFile: string;
}): Promise<(() => Promise<void>) | null> {
  if (!options.specs.some((spec) => spec.endsWith("access-token-401-auto-logout.test.ts")))
    return null;

  const pending: ServerResponse[] = [];
  let businessRequestCount = 0;
  let rejected = false;
  let rejectionStatus = 401;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const path = url.pathname;
    response.setHeader("content-type", "application/json");
    if (path === "/__e2e/reject") {
      rejectionStatus = url.searchParams.get("status") === "200" ? 200 : 401;
      rejected = true;
      for (const waiting of pending.splice(0)) {
        waiting.writeHead(rejectionStatus);
        waiting.end('{"code":401,"msg":"登录状态已过期","success":false}');
      }
      response.end("{}");
      return;
    }
    if (path === "/__e2e/status") {
      response.end(JSON.stringify({ businessRequestCount, rejectionStatus, rejected }));
      return;
    }
    if (path === "/api/biz/customer/getCustomerInfo") {
      // 只记录是否匹配合成业务 token，避免 token 原文进入测试产物。
      if (request.headers.authorization === "e2e-business-access-token") businessRequestCount++;
      if (rejected) {
        response.writeHead(rejectionStatus);
        response.end('{"code":401,"msg":"登录状态已过期","success":false}');
      } else pending.push(response);
      return;
    }
    // 控制面始终 200，保证失效提示只能来自上面的业务 token 请求。
    response.end(
      JSON.stringify({
        code: 0,
        data: { configs: {}, builtinModels: [], config_version: "oauth-401-fixture" },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth fixture 缺少监听端口");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const envPatch = {
    ZCODE_E2E_ACCESS_TOKEN_401_URL: baseUrl,
    BIGMODEL_API_BASE_URL: baseUrl,
    BIGMODEL_OAUTH_USERINFO_URL: `${baseUrl}/api/biz/customer/getCustomerInfo`,
    ZAI_BUSINESS_BASE_URL: baseUrl,
    ZCODE_BASE_URL: baseUrl,
    ZCODE_TEST_BASE_URL: baseUrl,
    ZCODE_ENDPOINT_ORIGIN: baseUrl,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  await writeFile(
    options.credentialsFile,
    JSON.stringify({
      "oauth:active_provider": "bigmodel",
      "oauth:bigmodel:access_token": "e2e-business-access-token",
      "oauth:bigmodel:refresh_token": "e2e-refresh-token",
      "oauth:bigmodel:user_info": JSON.stringify({
        id: "e2e-user",
        username: "Fixture User",
        displayName: "Fixture User",
      }),
      zcodejwttoken: "e2e-distinct-zcode-jwt",
      "bot:e2e:credential": "e2e-independent-bot-token",
    }),
    { mode: 0o600 },
  );
  const settings = JSON.parse(await readFile(options.settingsFile, "utf8"));
  await writeFile(
    options.settingsFile,
    JSON.stringify({ ...settings, providerFamilyDomain: "bigmodel" }),
  );

  return async () => {
    for (const response of pending.splice(0)) response.destroy();
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
