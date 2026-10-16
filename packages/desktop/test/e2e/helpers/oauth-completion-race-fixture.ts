import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

export async function prepareOAuthCompletionRaceFixture(
  specs: string[],
): Promise<(() => Promise<void>) | null> {
  if (!specs.some((spec) => spec.endsWith("oauth-completion-race.test.ts"))) return null;
  let tokenResponse: ServerResponse | undefined;
  let tokenRequests = 0;
  let readyResponses = 0;
  let pollingEnabled = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.setHeader("content-type", "application/json");
    if (path === "/__e2e/status") {
      response.end(JSON.stringify({ tokenRequests, readyResponses }));
    } else if (path === "/__e2e/enable-poll") {
      pollingEnabled = true;
      response.end("{}");
    } else if (path === "/__e2e/complete-token") {
      tokenResponse?.end(
        JSON.stringify({
          code: 0,
          data: { token: "cancelled-jwt", bigmodel: { access_token: "cancelled-business" } },
        }),
      );
      tokenResponse = undefined;
      response.end("{}");
    } else if (path === "/__e2e/fail-token") {
      tokenResponse?.writeHead(500);
      tokenResponse?.end('{"code":500,"msg":"controlled exchange failure"}');
      tokenResponse = undefined;
      response.end("{}");
    } else if (path === "/api/v1/oauth/cli/init") {
      tokenRequests = 0;
      readyResponses = 0;
      response.end(
        JSON.stringify({
          code: 0,
          data: {
            authorize_url: "https://example.com/authorize?state=e2e-race&channel_id=desktop-launch",
            expires_at: Math.floor(Date.now() / 1000) + 300,
            flow_id: "e2e-race",
            poll_interval_sec: 1,
          },
        }),
      );
    } else if (path === "/api/v1/oauth/token") {
      tokenRequests++;
      tokenResponse = response;
    } else if (path === "/api/v1/oauth/cli/poll/e2e-race") {
      if (!pollingEnabled || !tokenRequests) response.end('{"code":0,"data":{"status":"pending"}}');
      else {
        readyResponses++;
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              status: "ready",
              token: "e2e-race-jwt",
              user: { user_id: "e2e-race-user", name: "Race User" },
              bigmodel: { access_token: "e2e-race-business" },
            },
          }),
        );
      }
    } else {
      response.end(
        JSON.stringify({
          code: 0,
          data: { configs: {}, builtinModels: [], config_version: "oauth-race" },
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth race fixture 缺少端口");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const envPatch = {
    ZCODE_E2E_OAUTH_RACE_URL: baseUrl,
    ZCODE_CREDENTIAL_SECRET: "oauth-completion-race-fixture",
    ZCODE_BASE_URL: baseUrl,
    ZCODE_TEST_BASE_URL: baseUrl,
    ZCODE_ENDPOINT_ORIGIN: baseUrl,
    BIGMODEL_API_BASE_URL: baseUrl,
    BIGMODEL_OAUTH_USERINFO_URL: `${baseUrl}/api/biz/customer/getCustomerInfo`,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  return async () => {
    tokenResponse?.destroy();
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
