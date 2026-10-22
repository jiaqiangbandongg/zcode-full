import type { ConversationSharePreflightRequest } from "@/conversation-share-interaction/contract.js";
import { scheduleConversationSharePreflightRequest } from "@/conversation-share-interaction/conversationSharePreflightRequest.js";

/** effect 返回取消函数；依赖变化或卸载即作废旧代际，状态仍由传入的 owner 回调更新。 */
export function beginSharePreflight<T>(owner: ConversationSharePreflightRequest<T>): () => void {
  return scheduleConversationSharePreflightRequest(owner);
}
