import {
  ApiError,
  ProjectAccessTokenClient,
  ProjectAccessTokenTransientError,
  type ApiClient,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "#src/providers/api/apiJson.js";

const PROJECT_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("project-access-token");

/** 本地与旧远程附加入口复用同一 HTTP/ID 存储约束，每个鉴权 owner 只持有一个实例。 */
export function createAccountProjectTokenClient(
  apiClient: ApiClient,
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">,
): ProjectAccessTokenClient {
  return new ProjectAccessTokenClient({
    request: async (url, init) => {
      try {
        return await readApiJson(apiClient, url, {
          ...init,
          timeoutMs: PROJECT_TOKEN_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { code: 404 };
        // 仅承认传输异常/内部超时及临时 HTTP 状态；JSON 解析和未知异常不能恢复旧 PAT。
        if (
          error instanceof ApiError &&
          (error.status === 429 ||
            (error.status !== undefined && error.status >= 500 && error.status < 600) ||
            (error.status === undefined &&
              (error.cause instanceof TypeError ||
                (error.cause instanceof DOMException &&
                  ["AbortError", "TimeoutError"].includes(error.cause.name)))))
        )
          throw new ProjectAccessTokenTransientError();
        throw error;
      }
    },
    locationStore: credentialService,
    observe: (event) =>
      log.warn(
        undefined,
        event.code === "project_token_refresh_deferred"
          ? "项目 Token 提前刷新暂缓"
          : "项目 Token 获取失败",
        event,
      ),
  });
}
