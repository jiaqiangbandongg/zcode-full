import { hostIncomingMessageSchema } from "@zcode/shared";

export interface CloseableTransferredPort {
  close(): void;
}

export interface HostIncomingMessageEventLike {
  data: unknown;
  ports: readonly CloseableTransferredPort[];
}

function closeTransferredPort(port: CloseableTransferredPort | undefined): void {
  try {
    port?.close();
  } catch {
    // rejection cleanup 是 best effort；close 异常不能遮蔽原始 schema/初始化错误。
  }
}

/** schema invalid 时 transferred port 不会再被任何 ChannelServer 接管，必须就地关闭。 */
export function parseHostIncomingMessageEvent(
  event: HostIncomingMessageEventLike,
): ReturnType<typeof hostIncomingMessageSchema.safeParse> {
  // clean pnpm install 下 zod 会位于 @zcode/shared 私有 node_modules；导出函数若
  // 依赖推断返回型，.d.ts 会引用不可移植的私有 ZodSafeParseResult 路径。
  const result = hostIncomingMessageSchema.safeParse(event.data);
  if (!result.success) {
    for (const port of event.ports) closeTransferredPort(port);
  }
  return result;
}

/** AttachServicePort 早于 activeServices 就绪时拒绝并关闭，避免远端 RPC 永久 pending。 */
export function rejectUnavailableAttachedServicePort(
  port: CloseableTransferredPort,
  servicesReady: boolean,
): boolean {
  if (servicesReady) return false;
  closeTransferredPort(port);
  return true;
}
