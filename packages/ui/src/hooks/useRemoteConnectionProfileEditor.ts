import { useCallback, useState } from "react";
import type { ConnectionProfile } from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

/** 编辑框只保留表单草稿；打开时按当前展示状态关联的连接读取权威记录。 */
export function useRemoteConnectionProfileEditor() {
  const management = useBaseWorkspaceServices().sourceServerManagementService;
  const [editing, setEditing] = useState<{
    profile: ConnectionProfile;
    focusField: "host" | "auth";
  } | null>(null);
  const openEditor = useCallback(
    async (profileId: string, focusField: "host" | "auth") => {
      if (!management) return;
      const snapshot = await management.getSnapshot();
      const profile = snapshot.profiles.find(
        (candidate) => candidate.profileId === profileId && candidate.lifecycleState !== "retired",
      );
      if (!profile)
        throw Object.assign(new Error("Connection profile unavailable"), {
          code: "connection-profile-unavailable",
        });
      setEditing({ profile, focusField });
    },
    [management],
  );
  return { management, editing, openEditor, closeEditor: () => setEditing(null) };
}
