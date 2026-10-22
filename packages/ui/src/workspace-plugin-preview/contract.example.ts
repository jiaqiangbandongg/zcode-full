import type { WorkspacePluginPreviewProps } from "./contract.js";

export const previewExample: WorkspacePluginPreviewProps = {
  workspacePath: "/workspace/project",
  onOpen: () => {},
  onSelectPlugin: (mention) => {
    void mention.markdown;
  },
};
