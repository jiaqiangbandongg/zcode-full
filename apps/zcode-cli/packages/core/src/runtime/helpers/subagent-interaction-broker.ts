import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
} from "../deps.js";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "../../subagent/interaction-origin.js";

export interface SubagentInteractionBrokerContext extends SubagentInteractionOriginContext {
  parentToolCallId?: PermissionBrokerRequest["toolCallId"] | string;
}

type BrokerResponse = ReturnType<PermissionBrokerPort["requestPermission"]>;

export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): BrokerResponse {
      // 修复原因：子 agent 的 permission / AskUserQuestion / ExitPlanMode 都需要父 task 的 UI 响应；
      // broker request 对外路由到父 session，origin 保留 child 归属，便于 UI 与日志识别来源。
      // 契约（2026-09-17 review）：registered 只是挂在 Promise 上的属性；本函数必须原样返回父 broker 的
      // 响应对象，不得改成 async 或加 .then 重新包装，否则信号静默丢失、executor 退回同步登记假设并
      // 重新引入"确认窗可见但 deferred 未登记"的竞态。subagent-interaction-broker.test.ts 守护该同一性。
      //
      // 本包装可以叠加。`sessionId` 由**外层**（离客户端更近的一层）
      // 最后改写，所以任意深度最终都落到根会话；`origin` 反过来保留**内层**已有值，
      // 归属永远是真正发起请求的那个子代理，不会被外层覆盖成中间层。
      return parentBroker.requestPermission(
        {
          ...request,
          sessionId: context.parentSessionId,
          origin: request.origin ?? buildSubagentInteractionOrigin(context, request.turnId),
        },
        options,
      );
    },
  };
}
