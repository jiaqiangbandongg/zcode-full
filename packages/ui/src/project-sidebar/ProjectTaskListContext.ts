import { createContext } from "react";
import type { ProjectTask } from "@/project-sidebar/contract.js";

/** 列表展示配置只来自侧栏 owner；不承载 Host 行集合或会话运行态。 */
export const ProjectTaskListContext = createContext<{
  isWebRemoteControl?: boolean;
  activeWorkspaceKey?: string;
  mobileActiveTaskKey?: string | null;
  onOpenTaskFiles?: (task: ProjectTask, remoteSessionId?: string) => Promise<void>;
  onPin?: (task: ProjectTask, pinned: boolean, commit: () => Promise<unknown>) => Promise<void>;
}>({});
