import type { FileEntry } from "@zcode/shared";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { IProjectService, ProjectDirectories, VirtualProject } from "#src/project/contract.js";
export { IProjectService } from "#src/project/contract.js";
export { createLegacySingleRootProjectService } from "#src/project/legacy-single-root.js";
export {
  createTaskAutoArchiveScheduler,
  shouldRescanTaskAutoArchive,
} from "#src/project/autoArchiveScheduler.js";
export type {
  ProjectTree,
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
  ProjectRoot,
  SaveProjectInput,
  ProjectDirectories,
} from "#src/project/contract.js";

interface ProjectDirectoryPort {
  home(): Promise<string>;
  read(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
}

async function readPrimaryRootStatus(
  path: string,
): Promise<NonNullable<VirtualProject["primaryRootStatus"]>> {
  try {
    return (await stat(path)).isDirectory() ? "available" : "missing";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
  }
}

async function projectPrimaryRootStatuses(projects: VirtualProject[]): Promise<VirtualProject[]> {
  // 主目录存在性属于文件系统事实；每次读取重新派生，不能把删除/恢复后的旧值固化进 SQLite。
  const checks = new Map<string, ReturnType<typeof readPrimaryRootStatus>>();
  return Promise.all(
    projects.map(async (project) => {
      const primary = project.roots.find((root) => root.isPrimary)?.rootPath;
      if (!primary || project.deleted) return project;
      let check = checks.get(primary);
      if (!check) {
        check = readPrimaryRootStatus(primary);
        checks.set(primary, check);
      }
      return { ...project, primaryRootStatus: await check };
    }),
  );
}

const saveProjectSchema = z
  .object({
    id: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    restoreProjectId: z.string().min(1).optional(),
    name: z.string().optional(),
    defaultName: z.string().optional(),
    roots: z.array(z.string().min(1)).optional(),
    primaryRoot: z.string().min(1).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.id && value.restoreProjectId), "project.ambiguous-save")
  .refine(
    (value) => !value.restoreProjectId || value.roots !== undefined,
    "project.restore-roots-required",
  );

export function createProjectService(options: {
  repository(): Promise<ProjectRepositoryContract>;
  workspaceDirectory: string;
  ownerHostId?: string;
  directories?: ProjectDirectoryPort;
  /** 只解析现有连接；连接缺失拒绝，不创建替代 Host。 */
  resolveHost?: (hostId: string) => Promise<IProjectService>;
  afterChange?: () => Promise<void>;
}): IProjectService {
  const route = async (hostId?: string) => {
    if (!hostId || hostId === (options.ownerHostId ?? "local")) return null;
    if (!options.resolveHost) throw new Error("project.host-offline");
    return options.resolveHost(hostId);
  };
  const creationFlights = new Map<string, Promise<ProjectDirectories>>();
  const changed = async () => {
    await options.afterChange?.();
  };
  const service: IProjectService = {
    async readDirectory(params = {}) {
      const input = z
        .object({
          hostId: z.string().min(1).optional(),
          path: z.string().min(1).optional(),
          includeHidden: z.boolean().optional(),
        })
        .strict()
        .parse(params);
      const remote = await route(input.hostId);
      if (remote) return remote.readDirectory(input);
      if (!options.directories) throw new Error("project.directory-service-unavailable");
      const requestedPath = input.path ?? (await options.directories.home());
      if (!isAbsolute(requestedPath)) throw new Error("project.absolute-path-required");
      // 目录匹配必须和本 Host 保存 root 的规则相同，不能在控制端按其操作系统处理远端路径。
      const path = normalize(requestedPath);
      return {
        path,
        entries: await options.directories.read({
          path,
          ...(input.includeHidden !== undefined ? { includeHidden: input.includeHidden } : {}),
        }),
      };
    },
    async readProjects(params) {
      const remote = await route(params?.hostId);
      return remote
        ? remote.readProjects({ includeDeleted: params?.includeDeleted })
        : projectPrimaryRootStatuses(
            (await options.repository()).readTree({
              includeDeleted: params?.includeDeleted,
              includeTasks: false,
            }).projects,
          );
    },
    async readTree(params) {
      const remote = await route(params?.hostId);
      if (remote)
        return remote.readTree({
          includeDeleted: params?.includeDeleted,
          includeDeletedTasks: params?.includeDeletedTasks,
        });
      // 只读：自动归档由 autoArchiveScheduler 定时执行，读取与点击都不改变 archived。
      const tree = (await options.repository()).readTree({
        includeDeleted: params?.includeDeleted,
        includeDeletedTasks: params?.includeDeletedTasks,
      });
      return { ...tree, projects: await projectPrimaryRootStatuses(tree.projects) };
    },
    async saveProject(input) {
      input = saveProjectSchema.parse(input);
      const remote = await route(input.hostId);
      if (remote) return remote.saveProject(input);
      const roots = input.roots
        ? [
            ...new Set(
              input.roots.map((path) => {
                if (!isAbsolute(path)) throw new Error("project.absolute-path-required");
                return normalize(path);
              }),
            ),
          ]
        : undefined;
      await Promise.all(
        (roots ?? []).map(async (path) => {
          if (!(await stat(path)).isDirectory()) throw new Error("project.directory-required");
        }),
      );
      const result = (await options.repository()).saveProject({
        ...input,
        roots,
        ...(input.primaryRoot ? { primaryRoot: normalize(input.primaryRoot) } : {}),
      });
      await changed();
      return result;
    },
    async deleteProject(id, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.deleteProject(id);
      (await options.repository()).deleteProject(id);
      await changed();
    },
    async moveTask(input) {
      const remote = await route(input.hostId);
      if (remote)
        return remote.moveTask({
          task: input.task,
          projectId: input.projectId,
          addMissingRoot: input.addMissingRoot,
        });
      // 确认增加缺失 root 时也校验目录，不能通过拖动绕过新增目录的存在性约束。
      if (input.addMissingRoot && !(await stat(input.task.workspacePath)).isDirectory())
        throw new Error("project.directory-required");
      (await options.repository()).moveTask(input);
      await changed();
    },
    async reorderProjects(ids, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.reorderProjects(ids);
      (await options.repository()).reorderProjects(ids);
      await changed();
    },
    async resolveSessionDirectories(task, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.resolveSessionDirectories(task);
      return (await options.repository()).resolveSessionDirectories(task);
    },
    async prepareSession(params) {
      const draftId =
        params?.draftId === undefined ? undefined : z.string().uuid().parse(params.draftId);
      if ((draftId && params?.projectId) || (params?.reuseDraft && !draftId))
        throw new Error("project.invalid-draft-target");
      const remote = await route(params?.hostId);
      if (remote) return remote.prepareSession({ projectId: params?.projectId });
      const id = params?.projectId;
      const remoteOwner = Boolean(options.ownerHostId && options.ownerHostId !== "local");
      // 旧入口可绕过项目直接在远端 mkdir；必须在目录或会话副作用之前拒绝。
      if (remoteOwner && !id) throw new Error("project.remote-project-required");
      if (id && creationFlights.has(id)) return creationFlights.get(id)!;
      const flight = (async (): Promise<ProjectDirectories> => {
        if (!id) {
          // 草稿 ID 在客户端先落盘；重复点击、回包丢失与重启重试都准备同一目录。
          // 无 draftId 的自动化/Bots 等调用仍独立分配，不能全局复用最近目录。
          const path = join(
            options.workspaceDirectory,
            draftId ? `draft-${draftId}` : `${Date.now()}-${randomUUID()}`,
          );
          // 已交付的目录若被移走，只报告缺失；不能用 mkdir 静默重建空目录。
          if (params?.reuseDraft) {
            if (!(await stat(path)).isDirectory()) throw new Error("project.directory-required");
          } else await mkdir(path, { recursive: true });
          return { workspacePath: path, additionalDirectories: [], projectId: null };
        }
        const repo = await options.repository();
        // 新建只需要项目目录；读取全量历史任务会阻塞草稿导航，复检也使用同一项目限定读取。
        let project = repo
          .readTree({ includeTasks: false })
          .projects.find((item) => item.id === id);
        if (!project) throw new Error("project.not-found");
        if (remoteOwner && project.roots.length !== 1)
          throw new Error("project.remote-single-root-required");
        if (!project.roots.length) {
          // 多窗口为同一空项目生成同一个目录，不依赖进程间定时锁。
          const path = join(options.workspaceDirectory, id);
          await mkdir(path, { recursive: true });
          // 空判断和 INSERT 必须共用写事务，防止另一 Host 的 roots 编辑被覆盖。
          project = repo.initializeProjectRoot(id, path);
          await changed();
        }
        const workspacePath = project.roots.find((root) => root.isPrimary)?.rootPath;
        if (!workspacePath) throw new Error("project.primary-root-missing");
        // 项目树与点击之间主目录仍可能被移走；创建入口必须复检，不能用 mkdir 复活旧路径或改选附加目录。
        const primaryRootStatus = await readPrimaryRootStatus(workspacePath);
        if (primaryRootStatus !== "available") {
          throw new Error(
            primaryRootStatus === "missing"
              ? "project.primaryRootMissing"
              : "project.primaryRootUnavailable",
          );
        }
        // 目录检查会让出执行权；项目在此期间删除时不得返回可用于首发的旧归属。
        if (
          !repo
            .readTree({ includeTasks: false })
            .projects.some((item) => item.id === id && !item.deleted)
        )
          throw new Error("project.not-found");
        return {
          projectId: id,
          workspacePath,
          additionalDirectories: project.roots
            .map((root) => root.rootPath)
            .filter((path) => path !== workspacePath),
        };
      })();
      if (id) creationFlights.set(id, flight);
      try {
        return await flight;
      } finally {
        if (id && creationFlights.get(id) === flight) creationFlights.delete(id);
      }
    },
  };
  return service;
}

/** 对外树使用 attachment 已登记的稳定身份；实际 cwd 与远端 canonical key 不改写。 */
export function bindRemoteProjectIdentities(
  service: IProjectService,
  resolveIdentity: (workspacePath: string) => Promise<string>,
): IProjectService {
  return {
    readProjects: (params) => service.readProjects(params),
    async readTree(params) {
      const tree = await service.readTree(params);
      // 空项目也会立即订阅侧栏状态。若只准备 task cwd，首次订阅会固定到未映射的
      // emitter，稍后打开目录才建立映射也无法重绑；必须先准备所有订阅目录再发布树。
      const paths = [
        ...new Set([
          ...tree.projects.flatMap((project) => project.roots.map((root) => root.rootPath)),
          ...tree.tasks.map((task) => task.workspacePath),
        ]),
      ];
      const identities = new Map(
        await Promise.all(paths.map(async (path) => [path, await resolveIdentity(path)] as const)),
      );
      return {
        ...tree,
        tasks: tree.tasks.map((task) => ({
          ...task,
          workspaceIdentity: identities.get(task.workspacePath)!,
        })),
      };
    },
    readDirectory: (params) => service.readDirectory(params),
    saveProject: (input) => service.saveProject(input),
    deleteProject: (id, hostId) => service.deleteProject(id, hostId),
    moveTask: (input) => service.moveTask(input),
    reorderProjects: (ids, hostId) => service.reorderProjects(ids, hostId),
    async prepareSession(params) {
      const directories = await service.prepareSession(params);
      return {
        ...directories,
        workspaceIdentity: await resolveIdentity(directories.workspacePath),
      };
    },
    async resolveSessionDirectories(task, hostId) {
      const directories = await service.resolveSessionDirectories(task, hostId);
      // 已有任务恢复曾漏补远程身份，导致同一 cwd 被导航隔离校验拒绝。
      // 以所属 Host 返回的真实目录解析身份，不复制请求身份或放宽导航校验。
      return {
        ...directories,
        workspaceIdentity: await resolveIdentity(directories.workspacePath),
      };
    },
  };
}
