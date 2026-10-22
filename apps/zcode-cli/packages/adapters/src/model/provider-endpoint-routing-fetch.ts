import type { ProviderEndpointRoutingPort, TraceContext } from "@zcode/contracts";

const TRACE_HEADER = "x-zcode-trace-id";

export type ProviderEndpointRoutingFetch = typeof globalThis.fetch;

export function createProviderEndpointRoutingFetch(options: {
  fetch: ProviderEndpointRoutingFetch;
  routingPort: ProviderEndpointRoutingPort;
  apiKeyId?: string;
}): ProviderEndpointRoutingFetch {
  return async (input, init) => {
    const requestUrl = readRequestUrl(input);
    if (!requestUrl) {
      return await options.fetch(input, init);
    }

    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    // 配置接口只接受账号 owner 返回的 ID，禁止从模型 PAT 或手工 Key 推导。
    const apiKeyId = options.apiKeyId;
    const decision = await options.routingPort.resolve(requestUrl, {
      ...(apiKeyId ? { apiKeyId } : {}),
      signal: signal ?? undefined,
      trace: readTraceContext(input, init),
    });
    if (!decision.routed) {
      return await options.fetch(input, init);
    }

    const rewrittenInput = rewriteInput(input, decision.url);
    return await options.fetch(rewrittenInput, routedRequestInit(input, init, decision.headers));
  };
}

function routedRequestInit(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  init: Parameters<ProviderEndpointRoutingFetch>[1],
  decisionHeaders: Readonly<Record<string, string>> | undefined,
): Parameters<ProviderEndpointRoutingFetch>[1] {
  const inputHeaders = input instanceof Request ? input.headers : undefined;
  if (!init?.headers && !inputHeaders && !decisionHeaders) {
    return init;
  }
  const headers = new Headers(init?.headers ?? inputHeaders);
  headers.delete("host");
  for (const [name, value] of Object.entries(decisionHeaders ?? {})) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

function readRequestUrl(input: Parameters<ProviderEndpointRoutingFetch>[0]): string | undefined {
  try {
    if (input instanceof Request) {
      return input.url;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return new URL(String(input)).href;
  } catch {
    return undefined;
  }
}

function rewriteInput(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  targetUrl: string,
): Parameters<ProviderEndpointRoutingFetch>[0] {
  if (input instanceof Request) {
    return new Request(targetUrl, input);
  }
  if (input instanceof URL) {
    return new URL(targetUrl);
  }
  return targetUrl;
}

function readTraceContext(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  init: Parameters<ProviderEndpointRoutingFetch>[1],
): TraceContext | undefined {
  const traceId = readRequestHeaders(input, init).get(TRACE_HEADER)?.trim();
  return traceId ? { traceId: traceId as TraceContext["traceId"] } : undefined;
}

function readRequestHeaders(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  init: Parameters<ProviderEndpointRoutingFetch>[1],
): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}
