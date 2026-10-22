import { useEffect, useMemo, useState } from "react";
import { type ConfigCatalogSnapshot } from "@/workspace-config-catalog/contract.js";
import { readConfigCatalog, projectConfigTargets } from "@/workspace-config-catalog/catalog.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { filterWorkspaceTabsForSettingsSource } from "@/settings/settingsSourceWorkspace.js";
import { logger } from "@/logger.js";
const EMPTY: ConfigCatalogSnapshot = { projects: [], directory: { hosts: [], entries: [] } };

export function useConfigWorkspaceTargets(sourceServerId?: string | null) {
  const services = useBaseWorkspaceServices();
  const tabs = useTabStore((state) => state.tabs);
  const [snapshot, setSnapshot] = useState(EMPTY);
  useEffect(() => {
    let serial = 0;
    const refresh = async () => {
      const request = ++serial;
      try {
        if (!services.projectService) throw new Error("project.service-unavailable");
        const result = await readConfigCatalog({
          projectService: services.projectService,
          remoteProjectService: services.remoteProjectService,
        });
        if (serial === request) setSnapshot(result);
      } catch (error) {
        if (serial !== request) return;
        setSnapshot(EMPTY);
        logger.error("[workspace-config-catalog] 读取配置目录失败", error);
      }
    };
    void refresh();
    const listener = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    return () => {
      ++serial;
      listener.dispose();
    };
  }, [services]);
  return useMemo(() => {
    const targets = projectConfigTargets(snapshot, tabs.filter(isWorkspaceTab));
    return sourceServerId === undefined
      ? targets
      : filterWorkspaceTabsForSettingsSource(targets, sourceServerId);
  }, [snapshot, sourceServerId, tabs]);
}
