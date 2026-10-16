import type { McpServerConfig, McpTestResult } from "@zcode/shared";

const MCP_PROBE_TIMEOUT_MS = 5000;

function normalizeMcpServerConfigForTest(config: McpServerConfig): McpServerConfig {
  if (config.type) {
    return config;
  }

  if (config.command) {
    return {
      ...config,
      type: "stdio",
    };
  }

  if (config.url) {
    return {
      ...config,
      type: "http",
    };
  }

  return config;
}

function buildUrlProbeRequest(config: McpServerConfig): RequestInit {
  return {
    method: config.type === "sse" ? "GET" : "OPTIONS",
    headers: config.headers,
  };
}

function isReachableHttpStatus(status: number): boolean {
  return status >= 200 && status < 500;
}

async function testUrlServer(
  config: McpServerConfig,
  startTime: number,
): Promise<McpTestResult> {
  if (!config.url) {
    return {
      success: false,
      error: "URL 类型服务器缺少 url 配置",
      response_time: Date.now() - startTime,
    };
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MCP_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      ...buildUrlProbeRequest(config),
      signal: controller.signal,
    });

    return {
      success: isReachableHttpStatus(response.status),
      error: isReachableHttpStatus(response.status)
        ? undefined
        : `HTTP ${response.status} ${response.statusText}`.trim(),
      response_time: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: errorMessage,
      response_time: Date.now() - startTime,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function testStdioServer(config: McpServerConfig, startTime: number): McpTestResult {
  if (!config.command?.trim()) {
    return {
      success: false,
      error: "stdio 类型服务器缺少 command 配置",
      response_time: Date.now() - startTime,
    };
  }

  return {
    success: true,
    response_time: Date.now() - startTime,
  };
}

export async function testMcpConnectivity(config: McpServerConfig): Promise<McpTestResult> {
  const startTime = Date.now();
  const normalizedConfig = normalizeMcpServerConfigForTest(config);

  if (normalizedConfig.type === "stdio") {
    return testStdioServer(normalizedConfig, startTime);
  }

  if (normalizedConfig.url) {
    return testUrlServer(normalizedConfig, startTime);
  }

  return {
    success: false,
    error: `无效的 MCP 服务器配置: ${normalizedConfig.type ?? "unknown"}`,
    response_time: Date.now() - startTime,
  };
}
