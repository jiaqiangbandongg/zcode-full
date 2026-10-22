import { useMemo } from "react";
import { buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { projectKey } from "@/project-sidebar/view.js";
export function useSavedWorkflowProjectOptions(): AutomationWorkspaceOption[] {
  const directory = useOptionalProjectDirectory();
  return useMemo(
    () =>
      (directory?.projects ?? []).flatMap((project) => {
        const root = project.roots.find((root) => root.isPrimary)?.rootPath;
        if (
          !root ||
          project.deleted ||
          directory?.availability.get(projectKey(project))?.online === false
        )
          return [];
        return [
          {
            projectId: project.id,
            hostId: project.hostId,
            workspacePath: root,
            label: project.name,
            ...(project.hostId === "local"
              ? {}
              : { workspaceIdentity: buildRemoteHostWorkspaceIdentity(project.hostId, root) }),
          },
        ];
      }),
    [directory?.projects, directory?.availability],
  );
}
