import type { RemoteTarget } from "@zcode/shared";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import {
  type ConnectSourceServerOptions,
  type SourceServerConnectionManager,
} from "./sourceServerConnectionManager.js";

/** Host 手动连接入口：目录持有 profile/凭据，Manager 决定实际连接归属。 */
export async function connectSourceServerTarget(
  directory: Pick<SourceServerDirectory, "ensureProfile">,
  manager: Pick<SourceServerConnectionManager, "connect">,
  options: Omit<ConnectSourceServerOptions, "profile" | "target"> & {
    target: Exclude<RemoteTarget, { kind: "server" }>;
  },
) {
  const profile = await directory.ensureProfile(options.target, { deferCredentials: true });
  const connection = await manager.connect({
    ...options,
    profile,
    onAuthenticatedUpgradeRequired: async () => {
      // 仅真正执行本次认证的 flight 可提交凭据；加入后台 flight 的请求不会继承资格。
      options.context?.signal?.throwIfAborted();
      await directory.ensureProfile(options.target);
    },
  });
  options.context?.signal?.throwIfAborted();
  // Manager 返回复用事实时，本次输入未参与最终连接；保留原 profile 和 credential refs。
  const committedProfile = connection.reusedConnectionTarget
    ? profile
    : await directory.ensureProfile(options.target);
  return { profile: committedProfile, connection };
}
