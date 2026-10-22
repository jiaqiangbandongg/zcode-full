import { join } from "node:path";

import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  isCuaLocalDevelopmentRuntime,
  resolveCuaHelperInstallRoot,
  resolveHelperAppName,
  standaloneHelperCandidatePaths,
} from "@zcode/zcode-cua/broker/server";

export function resolveStandaloneStatusLaunchCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = [...standaloneHelperCandidatePaths(env)];
  if (isCuaLocalDevelopmentRuntime(env)) {
    const installRoot = resolveCuaHelperInstallRoot(env);
    if (installRoot) {
      const fallbackName =
        resolveHelperAppName(env) === DEV_HELPER_APP_NAME ? HELPER_APP_NAME : DEV_HELPER_APP_NAME;
      candidates.push(join(installRoot, fallbackName));
    }
  }
  return candidates;
}

export interface StandaloneStatusLaunchAppPathOptions {
  env: NodeJS.ProcessEnv;
  bundledAppPath: string | undefined;
  exists: (path: string) => boolean;
  ensureInstalled: (bundledAppPath: string) => Promise<string>;
}

export async function resolveStandaloneStatusLaunchAppPath({
  env,
  bundledAppPath,
  exists,
  ensureInstalled,
}: StandaloneStatusLaunchAppPathOptions): Promise<string | null> {
  if (bundledAppPath && exists(bundledAppPath)) {
    return ensureInstalled(bundledAppPath);
  }
  return resolveStandaloneStatusLaunchCandidates(env).find(exists) ?? null;
}
