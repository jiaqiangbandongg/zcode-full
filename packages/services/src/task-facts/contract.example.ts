import type { TaskFactsContract, TaskFactTarget } from "#src/task-facts/contract.js";
/** 调用者发送意图；不能先更新本地标题或另建重试队列。 */
export async function renameTaskExample(facts: TaskFactsContract, target: TaskFactTarget) {
  return facts.mutate(target, { type: "rename", title: "Review project" });
}
