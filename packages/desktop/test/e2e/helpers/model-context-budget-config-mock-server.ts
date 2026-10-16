import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";

const LEGACY_SPEC_FRAGMENT = "conversation-session-model-output-token-budget";
const PREFLIGHT_SPEC_FRAGMENT = "conversation-session-model-output-token-preflight";

export type ModelContextBudgetConfigMockScenario =
  | "config-pending"
  | "legacy"
  | "preflight-default";

export interface ModelContextBudgetConfigMockServer {
  baseUrl: string;
  scenario: ModelContextBudgetConfigMockScenario;
  stop(): Promise<void>;
}

export function resolveModelContextBudgetConfigMockScenario(
  specs: readonly string[],
): ModelContextBudgetConfigMockScenario | null {
  if (specs.some((spec) => spec.includes("conversation-session-config-independent-startup"))) {
    return "config-pending";
  }
  if (specs.some((spec) => spec.includes(PREFLIGHT_SPEC_FRAGMENT))) {
    return "preflight-default";
  }
  if (specs.some((spec) => spec.includes(LEGACY_SPEC_FRAGMENT))) {
    return "legacy";
  }
  return null;
}

export async function startModelContextBudgetConfigMockServer(
  scenario: ModelContextBudgetConfigMockScenario,
): Promise<ModelContextBudgetConfigMockServer> {
  // 修复原因：client/configs 是多个启动功能共享的配置源，不能为了 strategy 返回空 configs，
  // 否则套餐静态目录等无关消费者会在正式 E2E 中进入错误降级。
  const clientConfigFixtureUrl = new URL(
    "../fixtures/coding-plan-client-configs.json",
    import.meta.url,
  );
  const clientConfigPayload = JSON.parse(
    await readFile(clientConfigFixtureUrl, "utf8"),
  ) as ModelContextBudgetClientConfigFixture;
  if (scenario === "legacy") {
    clientConfigPayload.data.configs.modelContextBudget = {
      strategy: "legacy",
    };
  } else {
    // 默认策略 formal spec 必须省略字段，避免显式值掩盖缺省解析回归。
    delete clientConfigPayload.data.configs.modelContextBudget;
  }

  let configRequests = 0;
  let configResponses = 0;
  const heldResponses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/__scb/status") {
      sendJson(response, {
        blocked: scenario === "config-pending",
        configRequests,
        configResponses,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/client/configs") {
      configRequests += 1;
      if (scenario === "config-pending") {
        // 测试屏障保持请求 pending，不能用立即抛出“timeout”替代真实等待。
        heldResponses.add(response);
        response.on("close", () => heldResponses.delete(response));
        return;
      }
      configResponses += 1;
      sendJson(response, clientConfigPayload);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/zcode-plan/billing/balance") {
      // 预算 E2E 不验证套餐；返回合法的“无套餐”快照，避免共享 endpoint 产生无关 404。
      sendJson(response, {
        code: 0,
        data: { balances: [], plans: [] },
        msg: "",
        success: true,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v2/releases/latest") {
      // provider preset 同步与 client/configs 共享 endpoint；返回固定 config_version，
      // 让它继续复用上面的完整本地 fixture，不能因 strategy mock 等待远端超时。
      sendJson(response, {
        config_version: "0.0.13",
        version: "0.25.1",
      });
      return;
    }

    sendJson(
      response,
      {
        code: 404,
        data: null,
        msg: `Unhandled model context budget E2E path: ${request.method} ${url.pathname}`,
      },
      404,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Model context budget E2E mock server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    scenario,
    stop: async () => {
      for (const response of heldResponses) response.destroy();
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}

interface ModelContextBudgetClientConfigFixture {
  data: {
    configs: Record<string, unknown> & {
      modelContextBudget?: {
        strategy: "legacy" | "preflight-v1";
      };
    };
  };
}

function sendJson(response: ServerResponse, payload: unknown, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
