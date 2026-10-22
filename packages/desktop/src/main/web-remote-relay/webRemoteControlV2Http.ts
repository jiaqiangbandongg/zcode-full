import {
  WEB_REMOTE_CONTROL_RELAY_V2_HTTP,
  parseWebRemoteControlRelayV2HttpResponse,
  WebRemoteControlV2ConnectionError,
  type WebRemoteControlRelayV2HttpOperation,
  type WebRemoteControlRelayV2HttpRequest,
  type WebRemoteControlRelayV2HttpResponse,
} from "@zcode/shared/web-remote-relay";

/** Main 直接 Node fetch；不使用会触发全局登出的 services HTTP 客户端。 */
export function createWebRemoteControlV2Http(endpointOrigin: string, fetcher = fetch) {
  async function request<K extends WebRemoteControlRelayV2HttpOperation>(
    operation: K,
    body: WebRemoteControlRelayV2HttpRequest<K>,
    jwt: string,
    signal: AbortSignal,
  ): Promise<WebRemoteControlRelayV2HttpResponse<K>> {
    const { method, path } = WEB_REMOTE_CONTROL_RELAY_V2_HTTP[operation];
    try {
      const response = await fetcher(new URL(path, endpointOrigin), {
        method,
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      });
      if (response.status === 401) throw new WebRemoteControlV2ConnectionError("auth-required");
      if (!response.ok)
        throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
      // 读取正文也可能断网或超时，必须交给外层网络重试；只有完整但非法的 JSON 才是终态。
      const responseBody = await response.text();
      let value: unknown;
      try {
        value = JSON.parse(responseBody);
      } catch {
        throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      }
      const parsed = parseWebRemoteControlRelayV2HttpResponse(operation, value);
      if (!parsed || parsed.code !== 0)
        throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return parsed;
    } catch (error) {
      if (error instanceof WebRemoteControlV2ConnectionError) throw error;
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", true);
    }
  }
  return {
    async register(deviceMid: string, jwt: string, signal: AbortSignal) {
      const result = await request("register", { device_mid: deviceMid }, jwt, signal);
      if (!result.data) throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return result.data.device_sid;
    },
    async token(jwt: string, signal: AbortSignal) {
      const result = await request("token", { role: "device" }, jwt, signal);
      if (!result.data) throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return result.data.token;
    },
    async delete(deviceSid: string, jwt: string, signal: AbortSignal) {
      await request("delete", { device_sid: deviceSid }, jwt, signal);
    },
  };
}
