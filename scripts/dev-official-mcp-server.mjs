#!/usr/bin/env node
/*
 * 本地自测用的 fake 官方 Server MCP（Streamable HTTP）。
 *
 * 用途：验证运行中的 ZCode 实际发出的官方 MCP 身份头是否正确——包括当前登录身份的 JWT、
 * 选中 Coding Plan 的 key、Bigmodel-Target-Type，以及 Team 场景的 organization/project。
 * 同时跟踪协议生命周期（initialize / initialized / tools/list / tools/call），把每一步是否
 * 成功、失败原因、以及工具调用的入参与结果都打印出来。
 *
 * 用法：
 *   node scripts/dev-official-mcp-server.mjs [--port 3999]
 *        [--mode ok|401|403|redirect|tool-quota|tool-plan-required]
 *        [--fail-on all|initialize|tools/call]
 *        [--mcp-path /api/v1/mcp/server/image_search]
 *
 * 路由形态刻意与 zcode-server 对齐（`POST /api/v1/mcp/server/:mcp_group`，gin）：非匹配路径回
 * 404、路径带尾斜杠回 307。这样把线上那两个易错点（漏 group 段、多写尾斜杠）在本地就能复现。
 *
 * 只监听 127.0.0.1，不属于任何发布产物。
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { default: "3999", short: "p", type: "string" },
    // 与线上真实端点同形：/api/v1/mcp/server/:mcp_group。image_search 是服务端目前唯一注册的
    // group（zcode-server internal/domain/servermcp/service.go 的 MCPGroupTools）。
    "mcp-path": { default: "/api/v1/mcp/server/image_search", type: "string" },
    // 故障注入：验证 spec §6.3.3 的失败分类。
    //   ok          正常
    //   401         凭证被拒        -> official_auth_rejected（可观察"至多重试一次"）
    //   403         套餐/权限不足   -> official_auth_forbidden（不重试）
    //   redirect    302             -> official_auth_redirect_blocked（不跟随）
    //   tool-quota  HTTP 200，但 tools/call 返回业务级"额度耗尽"（isError + error_code）
    //   tool-plan-required 同上，但 error_code=coding_plan_required（无可用 Coding Plan）
    mode: { default: "ok", type: "string" },
    // 作用范围：all（默认）| initialize | tools/call
    //   initialize  → 模拟"连接时就发现没额度"
    //   tools/call  → 模拟"连上了，调用时额度耗尽"
    "fail-on": { default: "all", type: "string" },
    // 在 tools/call 前人为延迟 N 毫秒，用来复现"上游网关慢导致客户端超时"。
    // 设成大于 .mcp.json 的 timeoutMs 即可稳定触发客户端超时。
    "delay-ms": { default: "0", type: "string" },
  },
});
const port = Number(values.port);
const control = {
  delayMs: Number(values["delay-ms"]),
  failOn: String(values["fail-on"]),
  mode: String(values.mode),
};
// 归一化：去掉尾斜杠后作为 canonical 路径，尾斜杠请求由服务端回 307（与 gin 行为一致）。
const MCP_PATH = String(values["mcp-path"]).replace(/\/+$/, "") || "/";

const VALID_MODES = new Set(["ok", "401", "403", "redirect", "tool-quota", "tool-plan-required"]);
const VALID_FAIL_ON = new Set(["all", "initialize", "tools/call"]);
if (!VALID_MODES.has(control.mode) || !VALID_FAIL_ON.has(control.failOn)) {
  console.error(
    `无效参数：mode=${control.mode} fail-on=${control.failOn}\n` +
      `mode ∈ {${[...VALID_MODES].join(", ")}}，fail-on ∈ {${[...VALID_FAIL_ON].join(", ")}}`,
  );
  process.exit(1);
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const TOOL_NAME = "dev_echo_identity";
const PLUGIN_NAME = "dev-official-mcp";
const MCP_KEY = "dev-search";
const QUALIFIED_TOOL_NAME = `mcp__plugin_${PLUGIN_NAME}_${MCP_KEY}__${TOOL_NAME}`;

// 业务级失败的结果文本，与线上逐字段同形：zcode-server 的 ToolError.Error() 渲染成一行 JSON，
// 客户端只认 error_code 并据此在输入框上方提示（quota-banner spec §4）；形状不一致会让本地
// 看到的提示与线上不是一回事。
const IN_BAND_TOOL_FAILURES = {
  "tool-quota": {
    error_code: "quota_exceeded",
    message: "daily quota exceeded for bucket search_image (5/5), retry tomorrow or upgrade your coding plan",
  },
  "tool-plan-required": {
    error_code: "coding_plan_required",
    message: "a coding plan is required to use MCP tools, please purchase or configure a coding plan and retry",
  },
};

const IDENTITY_HEADERS = [
  "authorization",
  "x-bigmodel-authorization",
  "bigmodel-target-type",
  "bigmodel-organization",
  "bigmodel-project",
  // 已废弃的旧凭证通道。仍列在这里是为了让"客户端还在发它"这件事在自测时立刻可见——
  // 两个头同时发会让服务端额外校验 API key 归属，一把过期 key 就能让整个请求 403。
  "x-coding-plan-api-key",
];

/**
 * 只有两个 JWT 与旧的 Coding Plan key 是秘密，必须脱敏（首尾 4 位 + 长度）。
 * Bigmodel-Target-Type / Organization / Project 是身份标识而非凭证，原样打印——
 * 它们正是自测时最需要核对的字段（PERSONAL vs TEAM、org/project 是否成对）。
 */
const SECRET_HEADERS = new Set([
  "authorization",
  "x-coding-plan-api-key",
  "x-bigmodel-authorization",
]);

function formatHeader(name, value) {
  if (typeof value !== "string" || value.length === 0) return "(empty)";
  if (!SECRET_HEADERS.has(name)) return value;
  const prefix = value.startsWith("Bearer ") ? "Bearer " : "";
  const bare = prefix ? value.slice(prefix.length) : value;
  if (bare.length <= 8) return `${prefix}<len=${bare.length}>`;
  return `${prefix}${bare.slice(0, 4)}…${bare.slice(-4)} <len=${bare.length}>`;
}

/** 协议生命周期状态，用于每次请求后打印一行总览。 */
const state = {
  identityHeadersSeen: false,
  initialize: false,
  initialized: false,
  negotiatedVersion: undefined,
  sessionId: undefined,
  toolCallFail: 0,
  toolCallOk: 0,
  toolsListed: 0,
};

function statusLine() {
  const mark = (ok) => (ok ? "✓" : "✗");
  return (
    `   ★ initialize ${mark(state.initialize)} | initialized ${mark(state.initialized)} | ` +
    `tools/list ${state.toolsListed > 0 ? `✓(${state.toolsListed})` : "✗"} | ` +
    `tools/call ok=${state.toolCallOk} fail=${state.toolCallFail} | ` +
    `身份头 ${mark(state.identityHeadersSeen)}`
  );
}

/** 当前请求是否应被注入 HTTP 层故障。两个 tool-* 模式走业务错误，不在此处。 */
function shouldFail(rpcMethod, httpMethod) {
  if (control.mode === "ok" || IN_BAND_TOOL_FAILURES[control.mode]) return false;
  if (httpMethod === "GET") return false; // GET 探测始终回 405，不参与故障注入
  if (control.failOn === "all") return true;
  return control.failOn === rpcMethod;
}

let requestCount = 0;

function sendJsonRpc(response, id, payload, extraHeaders = {}) {
  response.writeHead(200, { "content-type": "application/json", ...extraHeaders });
  response.end(JSON.stringify({ id: id ?? null, jsonrpc: "2.0", ...payload }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    requestCount += 1;
    const raw = Buffer.concat(chunks).toString("utf8");
    let message = {};
    let parseError;
    try {
      message = raw ? JSON.parse(raw) : {};
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
    const rpcMethod = parseError ? "(unparsable body)" : message.method;

    const present = IDENTITY_HEADERS.filter((name) => request.headers[name] !== undefined);
    // 旧通道缺失是**预期**的，不算缺头；反过来它出现时会作为 ✓ 打印出来，一眼能看到回退。
    const missing = IDENTITY_HEADERS.filter(
      (name) => request.headers[name] === undefined && name !== "x-coding-plan-api-key",
    );
    if (present.includes("authorization") && present.includes("x-bigmodel-authorization")) {
      state.identityHeadersSeen = true;
    }

    console.log(
      `\n[#${requestCount}] ${request.method} ${request.url}` +
        (rpcMethod ? `  rpc=${rpcMethod}` : "") +
        (rpcMethod === "tools/call" ? `  tool=${message.params?.name ?? "(未指定)"}` : ""),
    );
    for (const name of present) {
      console.log(`   ✓ ${name}: ${formatHeader(name, String(request.headers[name]))}`);
    }
    for (const name of missing) {
      console.log(`   ✗ ${name}: (absent)`);
    }
    console.log(
      `   · x-request-id: ${request.headers["x-request-id"] ?? "(none)"}` +
        `  x-trace-id: ${request.headers["x-trace-id"] ?? "(none)"}`,
    );

    const seenSessionId = request.headers["mcp-session-id"];
    console.log(
      `   · mcp-session-id: ${seenSessionId ?? "(none)"}` +
        (rpcMethod === "initialize"
          ? "  ← initialize 不带是正常的（此时服务端还没下发）"
          : // GET 探测始终被 405，不参与 session 语义，因此不对它报缺失。
          state.sessionId && !seenSessionId && request.method !== "GET"
          ? "  ⚠ 服务端已下发但客户端未回传"
          : ""),
    );

    // 路由：与 zcode-server 的 gin 路由树同形，把线上两个易错点在本地复现。
    const requestPath = (request.url ?? "/").split("?")[0];
    if (requestPath === `${MCP_PATH}/`) {
      console.log(`   ✗ 路径多了尾斜杠 → 回 307（gin 同行为）。客户端 redirect:"manual"，`);
      console.log(`     会判成 official_auth_redirect_blocked。正确路径：${MCP_PATH}`);
      console.log(statusLine());
      response.writeHead(307, { location: MCP_PATH }).end();
      return;
    }
    if (requestPath !== MCP_PATH) {
      console.log(`   ✗ 路径不匹配 → 回 404。期望：${MCP_PATH}`);
      console.log("     线上同理：漏掉 :mcp_group 段（只写 /api/v1/mcp/server/）也是 404。");
      console.log(statusLine());
      response.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
      return;
    }

    // GET = SSE 推流探测。第一阶段官方 MCP 不启用推流，正确行为是回 405 让客户端安全放弃。
    if (request.method === "GET") {
      console.log("   → 回 405（第一阶段不启用服务端推流，spec §6.3.4）");
      console.log("     线上因 gin 只注册 POST，GET 实际是 404；对 SDK 行为等价。");
      console.log(statusLine());
      response.writeHead(405).end();
      return;
    }

    if (parseError) {
      console.log(`   ✗ 请求体解析失败：${parseError}`);
      console.log(statusLine());
      sendJsonRpc(response, null, {
        error: { code: -32700, message: `Parse error: ${parseError}` },
      });
      return;
    }

    if (shouldFail(rpcMethod, request.method)) {
      if (control.mode === "redirect") {
        console.log("   ✗ 注入 302 → 期望客户端不跟随，分类 official_auth_redirect_blocked");
        console.log(statusLine());
        response.writeHead(302, { location: "https://attacker.example/mcp" }).end();
        return;
      }
      const status = Number(control.mode);
      console.log(
        `   ✗ 注入 ${status} → 期望分类 ${
          status === 401
            ? "official_auth_rejected（至多重试一次，本终端应恰好出现两条注入日志）"
            : "official_auth_forbidden（不重试）"
        }`,
      );
      if (rpcMethod === "tools/call") state.toolCallFail += 1;
      console.log(statusLine());
      response.writeHead(status).end();
      return;
    }

    // 通知没有 id，按 MCP 惯例回 202 且无 body。
    if (rpcMethod === "notifications/initialized") {
      state.initialized = true;
      console.log("   → 回 202 Accepted（握手完成；这也是 SDK 尝试开 GET 推流的触发点）");
      console.log(statusLine());
      response.writeHead(202).end();
      return;
    }

    if (rpcMethod === "initialize") {
      // 协议版本协商：回显客户端请求的版本最安全——服务端擅自降级会让客户端判定不兼容。
      const requested = message.params?.protocolVersion;
      const negotiated =
        typeof requested === "string" && requested ? requested : DEFAULT_PROTOCOL_VERSION;
      state.initialize = true;
      state.negotiatedVersion = negotiated;
      state.sessionId = `dev-session-${Date.now().toString(36)}`;
      const clientInfo = message.params?.clientInfo;
      console.log(
        `   → 协议版本协商：client=${requested ?? "(未声明)"} server=${negotiated}` +
          (requested && requested !== negotiated ? "  ⚠ 已降级" : "  ✓"),
      );
      if (clientInfo) {
        console.log(`   → 客户端：${clientInfo.name ?? "?"} ${clientInfo.version ?? ""}`.trimEnd());
      }
      console.log(`   → 下发 mcp-session-id: ${state.sessionId}`);
      console.log(statusLine());
      sendJsonRpc(
        response,
        message.id,
        {
          result: {
            capabilities: { tools: { listChanged: false } },
            protocolVersion: negotiated,
            serverInfo: { name: "dev-official-mcp", version: "0.0.1" },
          },
        },
        { "mcp-session-id": state.sessionId },
      );
      return;
    }

    if (rpcMethod === "tools/list") {
      const tools = [
        {
          description: "本地自测用：回显服务端实际收到的官方 MCP 身份头名称（不回显凭证内容）",
          inputSchema: {
            additionalProperties: false,
            properties: {
              note: { description: "可选备注，会原样回显", type: "string" },
            },
            type: "object",
          },
          name: TOOL_NAME,
        },
      ];
      state.toolsListed = tools.length;
      console.log(`   → 返回 ${tools.length} 个工具：${tools.map((tool) => tool.name).join(", ")}`);
      console.log(`   → 模型侧完整名：${QUALIFIED_TOOL_NAME}`);
      console.log(statusLine());
      sendJsonRpc(response, message.id, { result: { tools } });
      return;
    }

    if (rpcMethod === "tools/call") {
      const requestedTool = message.params?.name;
      const args = message.params?.arguments ?? {};
      console.log(`   → 入参：${JSON.stringify(args)}`);

      if (control.delayMs > 0) {
        // 复现"上游慢 → 客户端预算先到期"。客户端超时后会断开，这里的响应会写到已关闭的
        // socket 上（被忽略），正好对应线上"服务端还在处理、客户端已放弃"的形态。
        console.log(`   ⏳ 人为延迟 ${control.delayMs}ms（--delay-ms）…`);
        await sleep(control.delayMs);
        if (response.writableEnded || response.destroyed) {
          console.log(`   ✗ 延迟结束时客户端已断开 → 这就是客户端超时的现场`);
          console.log(statusLine());
          return;
        }
      }

      if (requestedTool !== TOOL_NAME) {
        // 未知工具属业务错误，走 in-band isError（不是 JSON-RPC error）。
        state.toolCallFail += 1;
        console.log(`   ✗ 未知工具：${requestedTool ?? "(未指定)"} → isError`);
        console.log(statusLine());
        sendJsonRpc(response, message.id, {
          result: {
            content: [{ text: `unknown tool: ${String(requestedTool)}`, type: "text" }],
            isError: true,
          },
        });
        return;
      }

      const inBandFailure = IN_BAND_TOOL_FAILURES[control.mode];
      if (inBandFailure) {
        // MCP 业务错误走 in-band isError，不是 HTTP 状态码。这类失败**不属于**
        // §6.3.3 的鉴权分类：MCP 连接保持 connected，错误由模型/上层看到。
        state.toolCallFail += 1;
        console.log(
          `   ✗ 注入业务级失败 error_code=${inBandFailure.error_code} → isError（连接保持 connected）`,
        );
        console.log(statusLine());
        const text = JSON.stringify({
          ...inBandFailure,
          request_id: `dev-${state.toolCallFail}`,
        });
        sendJsonRpc(response, message.id, {
          result: { content: [{ text, type: "text" }], isError: true },
        });
        return;
      }

      state.toolCallOk += 1;
      const summary = {
        identityHeaders: present,
        negotiatedProtocolVersion: state.negotiatedVersion ?? null,
        note: typeof args.note === "string" ? args.note : null,
        sessionId: seenSessionId ?? null,
        targetType: request.headers["bigmodel-target-type"] ?? null,
        teamIdentityPaired: Boolean(
          request.headers["bigmodel-organization"] && request.headers["bigmodel-project"],
        ),
      };
      console.log(`   ✓ 调用成功，回显身份头：${present.join(", ") || "(无)"}`);
      console.log(statusLine());
      sendJsonRpc(response, message.id, {
        result: {
          content: [{ text: JSON.stringify(summary, null, 2), type: "text" }],
          structuredContent: summary,
        },
      });
      return;
    }

    // 其余方法按 JSON-RPC 规范返回 Method not found，而不是静默回空结果。
    console.log(`   ✗ 未实现的方法：${rpcMethod ?? "(无)"} → JSON-RPC -32601`);
    console.log(statusLine());
    sendJsonRpc(response, message.id, {
      error: { code: -32601, message: `Method not found: ${String(rpcMethod)}` },
    });
  });
});

process.on("SIGINT", () => {
  console.log("\n\n=== 本次会话总览 ===");
  console.log(statusLine().replace("   ★ ", ""));
  console.log(`总请求数：${requestCount}`);
  if (!state.identityHeadersSeen) {
    console.log("⚠ 从未收到完整身份头——客户端可能在发请求前就被拒（查 officialAuthKind）");
  }
  server.close(() => process.exit(0));
});

server.listen(port, "127.0.0.1", () => {
  const origin = `http://127.0.0.1:${port}`;
  const marketplace = "dev-official-marketplace";
  // 走 marketplace 安装（而非 plugins.dirs）：这是官方插件真实的交付方式，
  // 也是新版设置页唯一会显示的形态——settings 的 selectPluginsForScope 只显示
  // installedPlugins 里有记录的、或 source === "official" 的插件，
  // 因此经 plugins.dirs 挂进来的 inline 插件在那里不可见（agent 侧照常加载）。
  const pluginId = `${PLUGIN_NAME}@${marketplace}`;
  const marketRoot = `${process.env.HOME ?? "~"}/.zcode-dev-plugins/${marketplace}`;

  console.log(`fake 官方 MCP 已监听 ${origin}${MCP_PATH}`);
  console.log("  （路径与线上 POST /api/v1/mcp/server/:mcp_group 同形；其它路径回 404）");
  console.log(`故障注入：mode=${control.mode} fail-on=${control.failOn}`);
  console.log(`期望的 pluginId：${pluginId}`);
  console.log(`模型侧工具全名：${QUALIFIED_TOOL_NAME}\n`);
  console.log("=== 四步 ===\n");
  console.log("1) 建本地 marketplace（含一个插件）：");
  console.log(`
mkdir -p ${marketRoot}/.claude-plugin ${marketRoot}/${PLUGIN_NAME}/.zcode-plugin
cat > ${marketRoot}/.claude-plugin/marketplace.json <<'JSON'
{
  "name": "${marketplace}",
  "plugins": [{ "name": "${PLUGIN_NAME}", "source": "./${PLUGIN_NAME}" }]
}
JSON
cat > ${marketRoot}/${PLUGIN_NAME}/.zcode-plugin/plugin.json <<'JSON'
{ "name": "${PLUGIN_NAME}", "version": "0.0.1" }
JSON
cat > ${marketRoot}/${PLUGIN_NAME}/.mcp.json <<'JSON'
{
  "mcpServers": {
    "${MCP_KEY}": {
      "type": "http",
      "url": "${origin}${MCP_PATH}",
      "auth": { "type": "zcode_official", "provider": "jwt_token" }
    }
  }
}
JSON
`);
  console.log("2) 在设置页「添加 marketplace」里填这个目录（注意是 marketplace 根目录，");
  console.log(`   不是插件目录）：${marketRoot}`);
  console.log("   然后在插件列表里找到 " + PLUGIN_NAME + " 并「安装」。");
  console.log("   若之前用 plugins.dirs 挂过同名插件，先从 ~/.zcode/cli/config.json 的");
  console.log("   plugins.dirs 里移除，避免两个来源的同名插件互相干扰。\n");
  console.log("3) 安装后**启用**它——marketplace 安装的插件默认不启用，未启用时其 MCP 不会被解析：");
  console.log("   设置页直接打开开关即可；或写配置：");
  console.log(`
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const f=path.join(os.homedir(),".zcode/cli/config.json");
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.plugins=c.plugins||{};
c.plugins.enabled=true;
c.plugins.enabledPlugins={...(c.plugins.enabledPlugins||{}),"${pluginId}":true};
c.plugins.dirs=(c.plugins.dirs||[]).filter((d)=>!d.includes("${PLUGIN_NAME}"));
fs.writeFileSync(f,JSON.stringify(c,null,2));
console.log("enabledPlugins.${pluginId} = true");
console.log("plugins.dirs =",c.plugins.dirs);
'
`);
  console.log("4) 带 dev 开关启动 desktop（值为逗号分隔的 loopback origin）：");
  console.log(`
export ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS='${origin}'
pnpm dev:desktop
`);
  console.log("   该开关只接受 http loopback，无法把凭证导向远端；不设置时一切 fail closed。");
  console.log(
    "   正式规则是「官方 marketplace 的 plugin + origin 等于当前 ZCode API origin」。\n" +
      `   本地 marketplace 叫 ${marketplace}（非官方），且 origin 是 loopback，\n` +
      "   因此自测必须依赖该开关。\n",
  );
  console.log("启动后让模型调用该工具，本终端会打印每一步的协议状态与身份头。");
  console.log("Ctrl-C 退出时会打印本次会话总览。\n");
});
