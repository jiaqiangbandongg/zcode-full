import {
  WEB_REMOTE_CONTROL_RELAY_V2_HTTP,
  WebRemoteControlV2ConnectionError,
  parseWebRemoteControlRelayV2HttpResponse,
} from "@zcode/shared/web-remote-relay";
import { withWebRemoteControlHttpSignal } from "#src/web-remote-control/adapters/webRemoteControlHttpSignal.js";

/** 一次性 token 不缓存；401 交给入口恢复登录，网络故障交给 transport 退避。 */
export function createWebRemoteControlV2TokenClient(origin: string, fetcher = fetch) {
  return async (jwt: string, signal: AbortSignal): Promise<string> => {
    try {
      return await withWebRemoteControlHttpSignal(signal, async (requestSignal) => {
        const response = await fetcher(
          new URL(WEB_REMOTE_CONTROL_RELAY_V2_HTTP.token.path, origin),
          {
            method: "POST",
            headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
            body: JSON.stringify({ role: "terminal" }),
            signal: requestSignal,
            redirect: "error",
          },
        );
        if (response.status === 401) throw new WebRemoteControlV2ConnectionError("auth-required");
        if (!response.ok)
          throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
        // 读取正文也可能断网或超时，必须交给外层网络重试；只有完整但非法的 JSON 才是终态。
        const body = await response.text();
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          throw new WebRemoteControlV2ConnectionError("relay-unavailable");
        }
        const result = parseWebRemoteControlRelayV2HttpResponse("token", value);
        if (!result || result.code !== 0 || !result.data)
          throw new WebRemoteControlV2ConnectionError("relay-unavailable");
        return result.data.token;
      });
    } catch (error) {
      // 不传播 fetch/服务端正文，避免一次性 token 与 JWT 进入 UI 或诊断日志。
      if (error instanceof WebRemoteControlV2ConnectionError) throw error;
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", true);
    }
  };
}
