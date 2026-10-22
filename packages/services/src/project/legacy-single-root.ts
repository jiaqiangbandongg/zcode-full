import type { AppSettings, FileEntry, SystemInfo, ZCodeTaskMeta } from "@zcode/shared";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type { IProjectService, VirtualProject, ProjectTask } from "#src/project/contract.js";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "#src/project/contract.js";

/** 旧 Server 的只读边界；实际 RPC 的选择由连接装配器完成。 */
interface LegacyProjectReadPort {
  directories: {
    info(): Promise<SystemInfo>;
    read(input: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  };
  readSettings(): Promise<Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">>;
  readTasks(input: {
    workspacePath: string;
    kind: "active" | "pinned" | "archived";
  }): Promise<ZCodeTaskMeta[]>;
  ensureConversation(): Promise<string>;
  readKnownWorkspaces?(): Promise<
    readonly { workspacePath: string; workspacePurpose?: "project" | "conversation" }[]
  >;
}

/** 仅由握手缺失 virtualProjects 的装配路径调用；没有数据库或 Agent 创建权限。 */
export function createLegacySingleRootProjectService(
  options: LegacyProjectReadPort & { hostId: string },
): IProjectService {
  const verifyHost = (hostId?: string) => {
    if (hostId && hostId !== options.hostId) throw new Error("project.cross-host-move");
  };
  const readOnly = async (): Promise<never> => {
    throw new Error("project.legacy-read-only");
  };
  const catalog = async () => {
    const [settings, info] = await Promise.all([
      options.readSettings(),
      options.directories.info(),
    ]);
    const pathRules = info.platform === "win32" ? win32 : posix;
    const local = (settings.lastWorkspaceSession ?? []).filter((entry) => entry.kind === "local");
    const known = [...local, ...((await options.readKnownWorkspaces?.()) ?? [])];
    const conversations = new Set(
      known
        .filter((entry) => entry.workspacePurpose === "conversation")
        .map((entry) => entry.workspacePath),
    );
    const paths = [
      ...new Set([
        ...known.map((entry) => entry.workspacePath),
        ...(settings.recentProjects ?? []),
      ]),
    ];
    const projects: VirtualProject[] = paths
      .filter((path) => !conversations.has(path))
      .map((rootPath, position) => ({
        id:
          LEGACY_SINGLE_ROOT_PROJECT_PREFIX +
          createHash("sha256")
            .update(JSON.stringify([options.hostId, rootPath]))
            .digest("hex"),
        hostId: options.hostId,
        legacySingleRoot: true,
        // 历史 cwd 可能含点段或不同分隔符；仅规范化匹配值，不能改合成 ID 的输入及任务绑定目录。
        directoryMatchPath: pathRules.normalize(rootPath),
        name: rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath,
        nameOverridden: false,
        roots: [{ rootPath, isPrimary: true, position: 0 }],
        position,
        pinned: false,
        deleted: false,
        createdAt: 0,
        updatedAt: 0,
      }));
    return { paths, projects };
  };
  const service: IProjectService = {
    async readDirectory(params) {
      verifyHost(params?.hostId);
      // 旧远端只读能力不应阻止选择已有项目；目录校验走远端文件服务，路径规则不能取本机平台。
      const info = await options.directories.info();
      const paths = info.platform === "win32" ? win32 : posix;
      const requested = params?.path?.trim() || info.homedir;
      if (!paths.isAbsolute(requested)) throw new Error("project.absolute-path-required");
      const path = paths.normalize(requested);
      const entries = await options.directories.read({
        path,
        ...(params?.includeHidden === undefined ? {} : { includeHidden: params.includeHidden }),
      });
      return { path, entries };
    },
    async readProjects(params) {
      verifyHost(params?.hostId);
      return (await catalog()).projects;
    },
    async readTree(params) {
      verifyHost(params?.hostId);
      const { paths, projects } = await catalog();
      const rows = await Promise.all(
        paths.map(async (workspacePath) => {
          const scope = { workspacePath };
          const [active, pinned, archived] = await Promise.all([
            options.readTasks({ ...scope, kind: "active" }),
            options.readTasks({ ...scope, kind: "pinned" }),
            options.readTasks({ ...scope, kind: "archived" }),
          ]);
          const projectId =
            projects.find((project) => project.roots[0]?.rootPath === workspacePath)?.id ?? null;
          return [
            ...active.map((task) => ({ ...task, pinned: false, archived: false })),
            ...pinned.map((task) => ({ ...task, pinned: true, archived: false })),
            ...archived.map((task) => ({ ...task, pinned: false, archived: true })),
          ].map((task): ProjectTask => ({ ...task, hostId: options.hostId, projectId }));
        }),
      );
      // 行集合仍来自远端 app 的索引；不读取 runtime snapshot 推导存在性或终态。
      // 旧协议的三个分区不是一个事务；置顶/归档交错可能让同一行出现两次。
      // 只对本次查询按 workspace 身份和 task ID 去重，不保存第二份任务索引。
      const tasks = [
        ...new Map(
          rows
            .flat()
            .map((task) => [
              JSON.stringify([task.workspaceIdentity?.trim() || task.workspacePath, task.taskId]),
              task,
            ]),
        ).values(),
      ];
      return { projects, tasks, legacySingleRoot: true };
    },
    async prepareSession(params) {
      verifyHost(params?.hostId);
      if (!params?.projectId)
        return {
          workspacePath: await options.ensureConversation(),
          projectId: null,
          additionalDirectories: [],
        };
      const project = (await catalog()).projects.find((item) => item.id === params.projectId);
      if (!project) throw new Error("project.not-found");
      return {
        workspacePath: project.roots[0]!.rootPath,
        projectId: project.id,
        additionalDirectories: [],
      };
    },
    async resolveSessionDirectories(task, hostId) {
      verifyHost(hostId);
      if (task.workspaceIdentity)
        verifyHost(remoteHostIdFromWorkspaceIdentity(task.workspaceIdentity) ?? undefined);
      const project = (await catalog()).projects.find(
        (item) => item.roots[0]?.rootPath === task.workspacePath,
      );
      return {
        workspacePath: task.workspacePath,
        projectId: project?.id ?? null,
        additionalDirectories: [],
      };
    },
    saveProject: readOnly,
    deleteProject: readOnly,
    moveTask: readOnly,
    reorderProjects: readOnly,
  };
  return service;
}
