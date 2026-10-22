import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createFakeRelayV2 } from "@zcode/shared/testing/fake-relay-v2";

export const WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS = {
  "oauth:active_provider": "zai",
  "oauth:zai:access_token": "mock-token",
  "oauth:zai:user_info": JSON.stringify({
    id: "zcode-e2e-user",
    username: "ZCode E2E",
    displayName: "ZCode E2E",
  }),
  zcodejwttoken: "mock-token",
};

/** 单窗口真实 OAuth owner → RPC → renderer → Main 回归，只替换外部 relay。 */
export async function prepareWebRemoteControlSessionEventsFixture(options: {
  credentialsFile: string;
  settingsFile: string;
  workspacePath: string;
  webUrl?: string;
}): Promise<() => Promise<void>> {
  const relay = await createFakeRelayV2({
    users: { "mock-token": "zcode-e2e-user" },
    onHttp: (call) => {
      if (call.path.startsWith("/api/v1/remote/")) return;
      // 完整工作区会读取推荐场景；配置对象不能冒充场景数组，否则真实首页渲染会崩溃。
      if (call.path === "/api/v1/client/scenes")
        return { status: 200, body: { code: 0, msg: "", data: [] } };
      if (options.webUrl && !call.path.includes("config"))
        return {
          status: 503,
          body: { code: 503, msg: "not configured in mobile file-navigation fixture" },
        };
      return {
        status: 200,
        body: {
          code: 0,
          data: { configs: {}, builtinModels: [], config_version: "session-events" },
        },
      };
    },
  });
  const envPatch = {
    // 账号后台请求也必须走 loopback；合成凭据发到默认业务 API 会触发401并提前登出。
    ...(options.webUrl ? { VITE_ZCODE_E2E_STORE_BRIDGE: "1" } : {}),
    ZAI_BUSINESS_BASE_URL: relay.httpUrl,
    ZCODE_E2E_REMOTE_AUTH_GATE_URL: relay.httpUrl,
    ZCODE_BASE_URL: relay.httpUrl,
    ZCODE_ENDPOINT_ORIGIN: relay.httpUrl,
    ZCODE_TEST_BASE_URL: relay.httpUrl,
    ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: relay.wsUrl,
    ZCODE_WEB_REMOTE_CONTROL_URL: options.webUrl ?? `${relay.httpUrl}/remote/v4`,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  // 手机入口与 desktop relay 必须连接同一个隔离服务，不能沿用开发服务器的线上代理。
  const web = options.webUrl
    ? spawn(
        process.execPath,
        [
          resolve(import.meta.dirname, "../../../../../node_modules/vite/bin/vite.js"),
          "--host",
          "127.0.0.1",
          "--port",
          "5173",
          "--strictPort",
        ],
        {
          cwd: resolve(import.meta.dirname, "../../../../../packages/web"),
          // 原因：wdio CLI 给 worker 注入 FORCE_COLOR="0"/"1"，picocolors 把任意非空值视为开启，
          // vite 会把端口染色成 `127.0.0.1:\x1b[1m5173`，下方就绪匹配永远失败，worker 无限等待。
          // NO_COLOR 优先于 FORCE_COLOR，保证就绪行是纯文本。
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
    : undefined;
  if (web) {
    await new Promise<void>((resolveReady, reject) => {
      web.once("error", reject);
      web.once("exit", (code) =>
        reject(new Error(`Mobile Web fixture exited before ready: ${code}`)),
      );
      web.stdout.on("data", (chunk) => {
        if (String(chunk).includes("http://127.0.0.1:5173")) resolveReady();
      });
      web.stderr.on("data", (chunk) => process.stderr.write(chunk));
    });
  }
  await writeFile(options.credentialsFile, JSON.stringify(WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS), {
    mode: 0o600,
  });
  const settings = JSON.parse(await readFile(options.settingsFile, "utf8"));
  await writeFile(
    options.settingsFile,
    JSON.stringify({
      ...settings,
      zcodeEndpointOrigin: relay.httpUrl,
      webRemoteControlLastEnabledContext: { workspacePath: options.workspacePath },
    }),
  );
  return async () => {
    if (web && web.exitCode === null) {
      const exited = once(web, "exit");
      web.kill();
      await exited;
    }
    await relay.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
