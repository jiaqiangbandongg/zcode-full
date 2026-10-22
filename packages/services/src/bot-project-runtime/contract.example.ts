import type { BotProjectRuntimePort, BotRemoteTarget } from "#src/bot-project-runtime/contract.js";
import { createBotProjectRuntime } from "#src/bot-project-runtime/index.js";
export async function example(port: BotProjectRuntimePort, target: BotRemoteTarget) {
  return createBotProjectRuntime(port).isConnected(target);
}
