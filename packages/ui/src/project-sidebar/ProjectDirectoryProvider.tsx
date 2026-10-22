import { useSourceServerDisplayNames } from "@/hooks/useSourceServerDisplayNames.js";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { countProjectTreeUnreadTasks } from "@/project-sidebar/view.js";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
import { useProjectSidebarPreferences } from "@/project-sidebar/useProjectSidebarPreferences.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useTaskGroups } from "@/project-sidebar/useTaskGroups.js";
import { selectSortedProjects } from "@/project-sidebar/view.js";

function useDirectoryState(isDesktop: boolean) {
  const result = useProjectTree(isDesktop);
  // 手机有项目目录不代表拥有 Source 管理权限；名称注册表仅在桌面订阅，手机沿用 Host 目录标签。
  const deviceNames = useSourceServerDisplayNames(isDesktop);
  const groups = useTaskGroups(result.factTree);
  const sortedProjects = useMemo(
    () => selectSortedProjects(result.factTree),
    [result.factTree.projects],
  );
  const preferences = useProjectSidebarPreferences(
    sortedProjects,
    result.loading,
    result.availability,
  );
  const projects = useMemo(() => {
    const sorted = preferences.sort(sortedProjects);
    return [...sorted.filter((p) => p.pinned), ...sorted.filter((p) => !p.pinned)];
  }, [sortedProjects, preferences.order]);
  // Context 不受消费方 memo 保护；父级更新 children 时，等价目录不能再次广播。
  return useMemo(
    () => ({ ...result, preferences, projects, groups, deviceNames }),
    [result, preferences, projects, groups, deviceNames],
  );
}
const Context = createContext<ReturnType<typeof useDirectoryState> | null>(null);
/** 侧栏和 composer 共享读取与偏好，避免各自订阅后出现两份项目目录。 */
export function ProjectDirectoryProvider({
  children,
  isDesktop = false,
}: {
  children: ReactNode;
  isDesktop?: boolean;
}) {
  const existing = useContext(Context);
  return existing ? children : <DirectoryOwner isDesktop={isDesktop}>{children}</DirectoryOwner>;
}
function DirectoryOwner({ children, isDesktop }: { children: ReactNode; isDesktop: boolean }) {
  const directory = useDirectoryState(isDesktop);
  // 任务栏/托盘角标与侧栏蓝点同源：数权威树的未读任务（过滤与 projectHasUnread 一致）。
  // 挂在 Provider owner（Root 顶层，常驻不卸载）而不是 ProjectSidebar：侧栏卸载期间
  // 后台完成的未读变化也要同步到任务栏/托盘。嵌入 pane / 测试环境无 Provider 时跳过。
  const platform = useOptionalPlatform();
  // 任务通知开关同时门控任务栏/托盘角标：关掉通知 = 连常驻提醒一起关闭
  // （同步 0 清空角标），侧栏蓝点作为应用内状态不受影响。
  const notificationEnabled = useZCodeStoreWithDefault(
    (state) => state.notificationEnabled,
    true,
  );
  const unreadTaskCount = useMemo(
    () => countProjectTreeUnreadTasks(directory.tree),
    [directory.tree],
  );
  useEffect(() => {
    platform?.syncWindowUnreadCount(notificationEnabled ? unreadTaskCount : 0);
  }, [platform, notificationEnabled, unreadTaskCount]);
  return <Context.Provider value={directory}>{children}</Context.Provider>;
}
export function useProjectDirectory() {
  const directory = useContext(Context);
  if (!directory) throw new Error("project.directory-provider-required");
  return directory;
}

/** 嵌入式 pane 可无侧栏；完整 Shell 必须使用同一目录 owner。 */
export function useOptionalProjectDirectory() {
  return useContext(Context);
}
