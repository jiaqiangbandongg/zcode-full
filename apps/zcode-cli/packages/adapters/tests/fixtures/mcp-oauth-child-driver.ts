/**
 * 跨进程 E2E 的子进程驱动。
 *
 * 由 tests/mcp-oauth-cross-process.e2e.test.ts 用 tsx 以真实 OS 进程拉起:真实文件锁、
 * 真实凭据文件、真实网络请求都在子进程里发生,主进程只负责托管假服务器与断言。
 * 这正是线上事故形态——竞态发生在多个 CLI 进程之间,同进程测试盖不住。
 *
 * 协议:argv[2] 是 JSON 配置;结束向 stdout 打印一行 JSON 结果;失败 exit 1。
 */
import { createSharedZCodeCredentialStore } from "../../src/auth/shared-credentials.js";
import { createMcpAdapter } from "../../src/mcp/index.js";
import { createMcpOAuthTokenProvider } from "../../src/mcp/oauth-provider.js";

interface DriverConfig {
  autoDrive?: boolean;
  credentialsPath: string;
  keyPrefix?: string;
  mcpUrl: string;
  mode: "refresh-race" | "authorize";
  secret: string;
  serverName?: string;
}

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "{}") as DriverConfig;
  const credentialStore = createSharedZCodeCredentialStore({
    env: { ZCODE_CREDENTIAL_SECRET: config.secret },
    filePath: config.credentialsPath,
  });

  if (config.mode === "refresh-race") {
    // 直接驱动 Phase 1 provider:并发临期刷新的单飞语义不依赖 transport。
    const provider = createMcpOAuthTokenProvider({
      config: { type: "authorization_code", scope: "mcp:tools" },
      credentialStore,
      keyPrefix: config.keyPrefix ?? "",
      serverName: "cross-process",
      serverUrl: config.mcpUrl,
    });
    const token = await provider.token();
    process.stdout.write(JSON.stringify({ token }));
    return;
  }

  // authorize 模式:完整建连。leader 会走到 openAuthorizationUrl(autoDrive 时自动完成
  // 浏览器动作);follower 只会收到 onAuthorizationRequired,绝不能重复驱动授权 URL。
  const authorizationUrls: string[] = [];
  const adapter = createMcpAdapter({
    mcpOAuth: {
      credentialStore,
      ...(config.autoDrive
        ? {
            openAuthorizationUrl: async ({ authorizationUrl }) => {
              authorizationUrls.push(authorizationUrl);
              const response = await fetch(authorizationUrl, { redirect: "manual" });
              const location = response.headers.get("location");
              if (location) await fetch(location);
            },
          }
        : {}),
      onAuthorizationRequired: () => undefined,
    },
  });
  try {
    const status = await adapter.connectServer(config.serverName ?? "cross-process", {
      type: "http",
      url: config.mcpUrl,
      oauth: { type: "authorization_code", scope: "mcp:tools" },
    });
    process.stdout.write(JSON.stringify({ authorizationUrls, status }));
  } finally {
    await adapter.close();
  }
}

void main().then(
  () => undefined,
  (error: unknown) => {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
