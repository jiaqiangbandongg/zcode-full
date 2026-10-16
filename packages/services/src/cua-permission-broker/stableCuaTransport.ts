import { mintBrokerSocketPath } from "@zcode/zcode-cua/broker";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { resolveWindowsCuaRuntime } from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

const logger = createServiceLogger("stable-cua-transport");

export interface StableCuaWinRecipe {
  command: string;
  entryPath: string;
  root: string;
  addonPath: string;
  commandEnv: Record<string, string>;
}

let stablePipeName: string | null = null;
let recipePromise: Promise<StableCuaWinRecipe | null> | null = null;
let recipeFailureLogged = false;

export function getStableCuaPipeName(): string {
  stablePipeName ??= mintBrokerSocketPath({ env: process.env });
  return stablePipeName;
}

export function resolveStableCuaWinRecipe(): Promise<StableCuaWinRecipe | null> {
  recipePromise ??= resolveWindowsCuaRuntime()
    .then((runtime) => ({
      command: runtime.command,
      entryPath: runtime.entryPath,
      root: runtime.root,
      addonPath: runtime.addonPath,
      commandEnv: runtime.commandEnv,
    }))
    .catch((error: unknown) => {
      if (!recipeFailureLogged) {
        recipeFailureLogged = true;
        logger.warn(
          undefined,
          `Windows CUA helper recipe unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      recipePromise = null;
      return null;
    });
  return recipePromise;
}

export function __resetStableCuaTransportForTest(): void {
  stablePipeName = null;
  recipePromise = null;
  recipeFailureLogged = false;
}
