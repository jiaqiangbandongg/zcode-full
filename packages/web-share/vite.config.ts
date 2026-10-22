import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  resolveBigModelApiOrigin,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "../shared/src/zcodeEndpoint.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
  const endpointEnv = { ...env, ZCODE_ENV: zcodeEnv };
  const endpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const oauthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  const oauthClientId = resolveZaiOAuthClientId(endpointEnv);
  // BigModel 授权入口必须跟随 ZCODE_ENV，否则测试环境会把测试账号带到生产授权页。
  const bigmodelOAuthOrigin = resolveBigModelApiOrigin(endpointEnv);

  return {
    root: resolve(HERE),
    base: "/cn/share/",
    // Share 复用 Web 的 material-icons 素材，但不复制完整 Web 源码/依赖。
    // 这样 dev:web-share 与 Docker 生产构建都从同一份 public 资源读取图标。
    publicDir: resolve(REPO_ROOT, "packages/web/public"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: "@", replacement: resolve(REPO_ROOT, "packages/ui/src") },
        // Docker 只给 web-share 安装依赖，复用的 Web/UI 源文件找不到同级依赖链接。
        // 根入口必须精确匹配，避免把 shared/mcp-apps 等子路径改写成 index.ts/mcp-apps。
        {
          find: /^@zcode\/shared$/,
          replacement: resolve(REPO_ROOT, "packages/shared/src/index.ts"),
        },
        // Share 镜像不安装 @zcode/ui（它会带入 services/rpc 闭包），子路径导入必须显式指向源码。
        {
          find: "@zcode/ui/useTheme",
          replacement: resolve(REPO_ROOT, "packages/ui/src/useTheme.ts"),
        },
        // 只读时间线的协议子路径同时是 shareBuildBoundary 守卫的准入声明。
        {
          find: "@zcode/shared/zcode-protocol-v4",
          replacement: resolve(REPO_ROOT, "packages/shared/src/zcode-protocol-v4/index.ts"),
        },
        // Bugfix：test-ids 改为只从子路径导入后，reasoning.tsx、ToolSummaryRow.tsx 等 share 闭包
        // 文件引用了它；镜像没有 packages/ui 的依赖链接，未登记别名时 Docker 构建解析失败。
        {
          find: "@zcode/shared/test-ids",
          replacement: resolve(REPO_ROOT, "packages/shared/src/test-ids.ts"),
        },
        {
          find: "@zcode/ui/conversation-share-readonly",
          replacement: resolve(REPO_ROOT, "packages/share-ui/src/index.ts"),
        },
        // 登录卡片要用 provider 图标；只依赖 shared/lucide/cn，不引入 services/rpc。
        {
          find: "@zcode/ui/oauth-provider-icon",
          replacement: resolve(REPO_ROOT, "packages/ui/src/lib/oauthProviderIcon.tsx"),
        },
      ],
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(oauthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(oauthOrigin),
      "import.meta.env.VITE_BIGMODEL_OAUTH_ORIGIN": JSON.stringify(bigmodelOAuthOrigin),
    },
    build: {
      outDir: resolve(REPO_ROOT, "packages/web-share/dist"),
      emptyOutDir: true,
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
