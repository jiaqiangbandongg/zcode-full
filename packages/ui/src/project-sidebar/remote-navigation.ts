import type {
  IProjectService,
  IRemoteProjectService,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";

/** 连接实例归 Host；这里只申请/绑定 logical attachment，不按 path 复用另一台设备的 scope。 */
export async function attachRemoteProjectWorkspace(input: {
  hostId: string;
  workspacePath: string;
  workspaceIdentity: string;
  expectedMembershipId?: string;
  projectId?: string | null;
  projectService?: Pick<IProjectService, "readProjects">;
  remoteService: IRemoteProjectService;
  isCurrent?(): boolean;
  findSession(identity: string): { sessionId: string } | undefined;
  connect: ProjectSidebarProps["onConnectRemote"];
  bind(
    sessionId: string,
    path: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ): Promise<void>;
  cancel: ProjectSidebarProps["onCancelRemoteProject"];
}): Promise<string> {
  const assertCurrent = () => {
    if (input.isCurrent?.() === false) throw new Error("project.navigation-cancelled");
  };
  assertCurrent();
  const host = await input.remoteService.connectHost(input.hostId);
  assertCurrent();
  if (host.id !== input.hostId || !host.target) throw new Error("project.host-identity-changed");
  if (input.expectedMembershipId && host.membershipId !== input.expectedMembershipId)
    throw new Error("remote-project.host-removed");
  const validateMembership = async () => {
    if (input.expectedMembershipId) {
      const directory = await input.remoteService.readDirectory();
      if (
        !directory.hosts.some(
          (item) => item.id === input.hostId && item.membershipId === input.expectedMembershipId,
        )
      )
        throw new Error("remote-project.host-removed");
    }
    if (input.projectService && input.projectId) {
      const projects = await input.projectService.readProjects({ hostId: input.hostId });
      if (
        !projects.some(
          (project) =>
            project.id === input.projectId &&
            project.hostId === input.hostId &&
            !project.deleted &&
            project.roots.length === 1 &&
            project.roots[0]?.rootPath === input.workspacePath,
        )
      )
        throw new Error("project.not-found");
    }
    assertCurrent();
    return true;
  };
  const existing = input.findSession(input.workspaceIdentity);
  const sessionId = existing?.sessionId ?? (await input.connect(host.target));
  try {
    // 连接和绑定都会等待远端；只回收本次创建的 attachment，不能取消其他项目复用的连接。
    assertCurrent();
    if (input.expectedMembershipId || input.projectService) {
      // Host 在连接等待中被移除再添加时，原请求不能借新成员的身份提交导航。
      await validateMembership();
      await input.bind(sessionId, input.workspacePath, validateMembership);
    } else if (input.isCurrent) await input.bind(sessionId, input.workspacePath, input.isCurrent);
    else await input.bind(sessionId, input.workspacePath);
    const bound = input.findSession(input.workspaceIdentity);
    if (bound?.sessionId !== sessionId) throw new Error("project.workspace-identity-mismatch");
    return sessionId;
  } catch (error) {
    if (!existing) await input.cancel(sessionId);
    throw error;
  }
}
