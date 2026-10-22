import type { IProjectService, ProjectDirectories } from "#src/project/contract.js";
import type { IRemoteProjectService, RemoteProjectHost } from "#src/remote-projects/contract.js";
import type { WindowHostRemoteWorkspaceDescriptor } from "@zcode/shared";
export type { ProjectDirectories, WindowHostRemoteWorkspaceDescriptor };
export interface ProjectNavigationRequest {
  projectId?: string | null;
  hostId?: string;
  draftId?: string;
  reuseDraft?: boolean;
  task?: { taskId: string; workspaceKey: string };
}
export interface ProjectNavigationResult extends ProjectDirectories {
  hostId: string;
  /** 由窗口 Registry admission 返回；本地没有远端 descriptor。 */
  remote?: WindowHostRemoteWorkspaceDescriptor;
}
export interface ProjectNavigationPort {
  projectService: Pick<
    IProjectService,
    "readProjects" | "readTree" | "prepareSession" | "resolveSessionDirectories"
  >;
  remoteProjectService: Pick<IRemoteProjectService, "readDirectory">;
  readConnectionOwner(hostId: string): object | undefined;
  /** 仅复用在线物理连接；在 Registry 提交前 await assertCurrent，失败只回收自己的 provisional scope。 */
  openRemoteWorkspace(input: {
    host: RemoteProjectHost;
    directories: ProjectDirectories;
    owner: object;
    assertCurrent(): Promise<void>;
  }): Promise<WindowHostRemoteWorkspaceDescriptor>;
}
/** Window Host 负责目录解析和 admission；main 不解释 project/task，也不创建物理连接。 */
export interface ProjectWorkspaceNavigation {
  prepare(request: ProjectNavigationRequest): Promise<ProjectNavigationResult>;
}
