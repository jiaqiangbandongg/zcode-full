import type { ISubagentsService } from "@zcode/services";
import type { ZCodeProvider } from "@zcode/shared";
import { getServiceAuthorityId } from "@/store/serviceAuthorityKey.js";

const inFlightAgentLoads = new Map<string, ReturnType<ISubagentsService["list"]>>();
let latestAgentLoadRequestId = 0;

function getAgentLoadKey(
  workspacePath: string,
  provider: ZCodeProvider,
  subagentsService: ISubagentsService,
  workspaceIdentity?: string,
): string {
  return `${getServiceAuthorityId(subagentsService)}::${
    workspaceIdentity?.trim() || workspacePath
  }::${provider}`;
}

export function loadAgentsOnce(
  workspacePath: string,
  provider: ZCodeProvider,
  subagentsService: ISubagentsService,
  workspaceIdentity?: string,
  options: { bypassCache?: boolean } = {},
): ReturnType<ISubagentsService["list"]> {
  const key = getAgentLoadKey(workspacePath, provider, subagentsService, workspaceIdentity);
  if (!options.bypassCache) {
    const current = inFlightAgentLoads.get(key);
    if (current) return current;
  }
  const request = subagentsService
    .list({ workspacePath, workspaceIdentity, provider })
    .finally(() => {
      if (inFlightAgentLoads.get(key) === request) inFlightAgentLoads.delete(key);
    });
  inFlightAgentLoads.set(key, request);
  return request;
}

export function nextAgentLoadRequestId(): number {
  latestAgentLoadRequestId += 1;
  return latestAgentLoadRequestId;
}

export function isLatestAgentLoadRequest(requestId: number): boolean {
  return requestId === latestAgentLoadRequestId;
}
