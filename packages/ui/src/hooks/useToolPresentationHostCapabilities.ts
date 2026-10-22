import { useMemo } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";
import type { ToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";

/** 宿主能力只在 App 装配；公开 renderer 不读取用户配置或平台服务。 */
export function useToolPresentationHostCapabilities(
  workspacePath: string,
): ToolPresentationCapabilities {
  const services = useOptionalServices();
  const platform = useOptionalPlatform();
  const modelProviderName = useWorkflowSubagentModelProviderName(workspacePath);
  const scopedAgents = useSubagentsContextStore((state) => {
    const candidates = Object.values(state.contexts).filter(
      (candidate) => candidate.workspacePath === workspacePath && candidate.loaded,
    );
    return candidates.length === 1 ? candidates[0]?.agents : undefined;
  });
  const fallbackAgents = useSubagentsStore((state) => state.agents);
  const agents = scopedAgents?.length
    ? scopedAgents
    : fallbackAgents.length
      ? fallbackAgents
      : useSubagentsStore.getState().agents;
  return useMemo(
    () => ({
      readMediaPreview: services
        ? (path: string) => services.fileService.readMediaPreview({ path })
        : undefined,
      getApplicationIcon: platform?.getApplicationIcon
        ? (request) => platform.getApplicationIcon!(request)
        : undefined,
      modelProviderName,
      agentColor: (name) => {
        const key = name.trim().toLowerCase();
        return agents.find(
          (agent) =>
            agent.name.trim().toLowerCase() === key || agent.id.trim().toLowerCase() === key,
        )?.color;
      },
    }),
    [services, platform, modelProviderName, agents],
  );
}
